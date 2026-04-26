/**
 * VoxFlow — Memory Layer
 * 3-tier persistent memory system:
 *   1. Short-term: In-memory circular buffer of recent turns
 *   2. Long-term: Conversation summaries stored in Qdrant (semantic search)
 *   3. Entity: Extracted user facts/preferences stored in Qdrant
 *
 * Uses Gemini for embeddings, summarization, and entity extraction.
 * Gracefully degrades if LLM or Qdrant is unavailable.
 */

import { QdrantClient } from '@qdrant/js-client-rest';
import { GoogleGenerativeAI } from '@google/generative-ai';

// ── Configuration ────────────────────────────────────────────
const MEMORY_COLLECTION = 'voxflow-memory';
const ENTITY_COLLECTION = 'voxflow-entities';
const EMBEDDING_DIM = 3072; // gemini-embedding-001
const SHORT_TERM_LIMIT = 20; // Max turns in the buffer
const SUMMARIZE_EVERY = 5;  // Summarize every N user turns
const RECALL_TOP_K = 3;     // Number of memories to recall

// ── State ────────────────────────────────────────────────────
let qdrantClient = null;
let embeddingModel = null;
let geminiModel = null;
let memoryReady = false;
let lastError = null;

// Short-term buffers: sessionId → Array<{ role, content, timestamp }>
const shortTermBuffers = new Map();

// Turn counters for periodic summarization: sessionId → number
const turnCounters = new Map();

// User preferences: sessionId → { topic: score }
const userPreferences = new Map();

// ══════════════════════════════════════════════════════════════
// ── Initialization ───────────────────────────────────────────
// ══════════════════════════════════════════════════════════════

/**
 * Initialize the memory layer.
 * Creates Qdrant collections if they don't exist.
 */
export async function initMemory() {
  console.log('[VoxFlow] 🧠 Initializing memory layer...');

  const qdrantUrl = process.env.QDRANT_URL;
  const qdrantApiKey = process.env.QDRANT_API_KEY;
  const geminiApiKey = process.env.GEMINI_API_KEY;

  if (!qdrantUrl || !qdrantApiKey || !geminiApiKey) {
    console.warn('[VoxFlow] ⚠️ Memory layer disabled — missing QDRANT or GEMINI env vars');
    memoryReady = false;
    lastError = 'Missing env vars';
    return false;
  }

  try {
    qdrantClient = new QdrantClient({
      url: qdrantUrl,
      apiKey: qdrantApiKey,
      checkCompatibility: false,
    });

    const genAI = new GoogleGenerativeAI(geminiApiKey);
    embeddingModel = genAI.getGenerativeModel({ model: 'gemini-embedding-001' });
    geminiModel = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

    // Ensure collections exist
    await ensureCollection(MEMORY_COLLECTION);
    await ensureCollection(ENTITY_COLLECTION);

    memoryReady = true;
    lastError = null;
    console.log('[VoxFlow] ✅ Memory layer initialized');
    return true;
  } catch (err) {
    memoryReady = false;
    lastError = err?.message || String(err);
    console.warn('[VoxFlow] ⚠️ Memory layer init failed:', lastError);
    return false;
  }
}

/**
 * Create a Qdrant collection if it doesn't already exist.
 */
async function ensureCollection(name) {
  try {
    const collections = await qdrantClient.getCollections();
    const exists = collections.collections.some(c => c.name === name);
    if (!exists) {
      await qdrantClient.createCollection(name, {
        vectors: { size: EMBEDDING_DIM, distance: 'Cosine' },
      });
      console.log(`[VoxFlow] 📦 Created collection: ${name}`);
    } else {
      console.log(`[VoxFlow] 📦 Collection exists: ${name}`);
    }
  } catch (err) {
    console.error(`[VoxFlow] Failed to ensure collection ${name}:`, err.message);
    throw err;
  }
}

export function isMemoryReady() {
  return memoryReady;
}

// ══════════════════════════════════════════════════════════════
// ── Short-Term Memory (Buffer) ──────────────────────────────
// ══════════════════════════════════════════════════════════════

/**
 * Record a conversation turn in the short-term buffer.
 * @param {string} sessionId
 * @param {'user'|'assistant'} role
 * @param {string} content
 */
export function recordTurn(sessionId, role, content) {
  if (!shortTermBuffers.has(sessionId)) {
    shortTermBuffers.set(sessionId, []);
  }

  const buffer = shortTermBuffers.get(sessionId);
  buffer.push({
    role,
    content: content.substring(0, 500), // Cap per-turn length
    timestamp: Date.now(),
  });

  // Trim to limit
  while (buffer.length > SHORT_TERM_LIMIT) {
    buffer.shift();
  }
}

/**
 * Get the short-term buffer for a session.
 * @param {string} sessionId
 * @returns {Array<{ role, content, timestamp }>}
 */
export function getShortTermBuffer(sessionId) {
  return shortTermBuffers.get(sessionId) || [];
}

/**
 * Build a context string from the short-term buffer.
 * @param {string} sessionId
 * @returns {string}
 */
export function getShortTermContext(sessionId) {
  const buffer = getShortTermBuffer(sessionId);
  if (buffer.length === 0) return '';

  return buffer
    .slice(-6) // Last 6 turns for immediate context
    .map(t => `${t.role}: ${t.content}`)
    .join('\n');
}

// ══════════════════════════════════════════════════════════════
// ── Long-Term Memory (Qdrant Summaries) ─────────────────────
// ══════════════════════════════════════════════════════════════

/**
 * Increment the turn counter and trigger summarization when needed.
 * Call after each user message.
 * @param {string} sessionId
 * @returns {Promise<boolean>} True if summarization was triggered
 */
export async function tickAndMaybeSummarize(sessionId) {
  const count = (turnCounters.get(sessionId) || 0) + 1;
  turnCounters.set(sessionId, count);

  if (count % SUMMARIZE_EVERY === 0 && memoryReady) {
    try {
      await summarizeAndStore(sessionId);
      return true;
    } catch (err) {
      console.error('[VoxFlow] Summarization error:', err.message);
    }
  }
  return false;
}

/**
 * Summarize the current short-term buffer using the LLM
 * and store the summary as a vector in Qdrant.
 * @param {string} sessionId
 */
async function summarizeAndStore(sessionId) {
  if (!memoryReady || !geminiModel || !embeddingModel) return;

  const buffer = getShortTermBuffer(sessionId);
  if (buffer.length < 3) return; // Not enough to summarize

  const conversationText = buffer
    .map(t => `${t.role}: ${t.content}`)
    .join('\n');

  // Summarize via LLM
  const summaryPrompt = `Summarize this conversation in 2-3 sentences. Focus on the key topics discussed, any user preferences or requests, and important information exchanged. Be concise.

Conversation:
${conversationText}

Summary:`;

  try {
    const result = await geminiModel.generateContent(summaryPrompt);
    const summary = result.response.text().trim();
    if (!summary) return;

    // Extract key topics
    const topics = extractTopicsFromBuffer(buffer);

    // Embed the summary
    const embedRes = await embeddingModel.embedContent(summary);
    const vector = embedRes?.embedding?.values;
    if (!Array.isArray(vector) || vector.length === 0) return;

    // Store in Qdrant
    const pointId = generatePointId();
    await qdrantClient.upsert(MEMORY_COLLECTION, {
      wait: true,
      points: [{
        id: pointId,
        vector,
        payload: {
          sessionId,
          summary,
          topics,
          turnCount: buffer.length,
          timestamp: Date.now(),
          createdAt: new Date().toISOString(),
        },
      }],
    });

    console.log(`[VoxFlow] 🧠 Stored memory summary for session ${sessionId.substring(0, 12)}... (${summary.substring(0, 60)}...)`);
  } catch (err) {
    console.error('[VoxFlow] Memory summarization failed:', err.message);
  }
}

/**
 * Extract topic keywords from buffer turns.
 */
function extractTopicsFromBuffer(buffer) {
  const userMsgs = buffer.filter(t => t.role === 'user').map(t => t.content);
  const words = userMsgs.join(' ').toLowerCase().split(/\s+/);
  const stopWords = new Set(['the', 'a', 'an', 'is', 'are', 'was', 'were', 'do', 'does', 'did', 'i', 'me', 'my', 'you', 'your', 'we', 'our', 'it', 'its', 'to', 'of', 'in', 'for', 'on', 'at', 'and', 'or', 'but', 'not', 'can', 'what', 'how', 'when', 'where', 'why', 'who', 'which', 'that', 'this', 'with', 'have', 'has', 'had', 'be', 'been', 'will', 'would', 'could', 'should']);
  const freq = {};
  for (const w of words) {
    const clean = w.replace(/[^a-z]/g, '');
    if (clean.length > 2 && !stopWords.has(clean)) {
      freq[clean] = (freq[clean] || 0) + 1;
    }
  }
  return Object.entries(freq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([word]) => word);
}

// ══════════════════════════════════════════════════════════════
// ── Entity Memory ───────────────────────────────────────────
// ══════════════════════════════════════════════════════════════

/**
 * Extract entities from a user message and store them.
 * Uses a lightweight LLM call for extraction.
 * @param {string} sessionId
 * @param {string} message
 */
export async function extractAndStoreEntities(sessionId, message) {
  if (!memoryReady || !geminiModel || !embeddingModel) return;

  // Only attempt extraction for messages likely containing personal info
  const hasEntitySignals = /\b(my name|i am|i'm|i like|i prefer|i want|i need|i work|i live|call me|favorite|i use|i have)\b/i.test(message);
  if (!hasEntitySignals) return;

  try {
    const extractPrompt = `Extract personal facts from this message. Return ONLY a JSON array of objects with "entity", "value", and "category" fields. Categories: name, preference, fact, work, location. If no personal facts, return [].

Message: "${message}"

JSON:`;

    const result = await geminiModel.generateContent(extractPrompt);
    const rawText = result.response.text().trim();

    // Parse JSON from response (handle markdown code blocks)
    let entities = [];
    try {
      const jsonStr = rawText.replace(/```json?\s*/g, '').replace(/```/g, '').trim();
      entities = JSON.parse(jsonStr);
    } catch {
      return; // LLM didn't return valid JSON
    }

    if (!Array.isArray(entities) || entities.length === 0) return;

    // Store each entity in Qdrant
    for (const entity of entities) {
      if (!entity.entity || !entity.value) continue;

      const entityText = `${entity.entity}: ${entity.value}`;
      const embedRes = await embeddingModel.embedContent(entityText);
      const vector = embedRes?.embedding?.values;
      if (!Array.isArray(vector) || vector.length === 0) continue;

      const pointId = generatePointId();
      await qdrantClient.upsert(ENTITY_COLLECTION, {
        wait: true,
        points: [{
          id: pointId,
          vector,
          payload: {
            sessionId,
            entity: entity.entity,
            value: entity.value,
            category: entity.category || 'fact',
            originalMessage: message.substring(0, 200),
            timestamp: Date.now(),
            createdAt: new Date().toISOString(),
          },
        }],
      });

      console.log(`[VoxFlow] 🏷️ Stored entity: ${entity.entity} = ${entity.value} (${entity.category})`);
    }
  } catch (err) {
    console.error('[VoxFlow] Entity extraction failed:', err.message);
  }
}

// ══════════════════════════════════════════════════════════════
// ── Memory Recall (Semantic Search) ─────────────────────────
// ══════════════════════════════════════════════════════════════

/**
 * Search long-term memory for relevant past conversations.
 * @param {string} sessionId
 * @param {string} query
 * @returns {Promise<Array<{ summary, topics, timestamp, score }>>}
 */
export async function recallMemory(sessionId, query) {
  if (!memoryReady || !embeddingModel) return [];

  try {
    const embedRes = await embeddingModel.embedContent(query);
    const vector = embedRes?.embedding?.values;
    if (!Array.isArray(vector) || vector.length === 0) return [];

    const results = await qdrantClient.search(MEMORY_COLLECTION, {
      vector,
      limit: RECALL_TOP_K,
      with_payload: true,
      filter: {
        must: [{ key: 'sessionId', match: { value: sessionId } }],
      },
    });

    return (results || [])
      .filter(r => r.score > 0.5) // Only relevant memories
      .map(r => ({
        summary: r.payload.summary,
        topics: r.payload.topics || [],
        timestamp: r.payload.timestamp,
        createdAt: r.payload.createdAt,
        score: r.score,
      }));
  } catch (err) {
    console.error('[VoxFlow] Memory recall error:', err.message);
    return [];
  }
}

/**
 * Search entity memory for relevant user facts.
 * @param {string} sessionId
 * @param {string} query
 * @returns {Promise<Array<{ entity, value, category, score }>>}
 */
export async function recallEntities(sessionId, query) {
  if (!memoryReady || !embeddingModel) return [];

  try {
    const embedRes = await embeddingModel.embedContent(query);
    const vector = embedRes?.embedding?.values;
    if (!Array.isArray(vector) || vector.length === 0) return [];

    const results = await qdrantClient.search(ENTITY_COLLECTION, {
      vector,
      limit: 5,
      with_payload: true,
      filter: {
        must: [{ key: 'sessionId', match: { value: sessionId } }],
      },
    });

    return (results || [])
      .filter(r => r.score > 0.5)
      .map(r => ({
        entity: r.payload.entity,
        value: r.payload.value,
        category: r.payload.category,
        score: r.score,
      }));
  } catch (err) {
    console.error('[VoxFlow] Entity recall error:', err.message);
    return [];
  }
}

/**
 * Recall all relevant context (memories + entities) for a query.
 * Returns a formatted string ready for LLM context injection.
 * @param {string} sessionId
 * @param {string} query
 * @returns {Promise<{ memoryContext: string, memorySources: string[], memoryCount: number }>}
 */
export async function recallAll(sessionId, query) {
  const [memories, entities] = await Promise.all([
    recallMemory(sessionId, query),
    recallEntities(sessionId, query),
  ]);

  const parts = [];
  const sources = [];

  if (entities.length > 0) {
    const entityLines = entities.map(e => `• ${e.entity}: ${e.value}`);
    parts.push(`[User Info]\n${entityLines.join('\n')}`);
    sources.push('Entity Memory');
  }

  if (memories.length > 0) {
    const memLines = memories.map(m => {
      const ago = formatTimeAgo(m.timestamp);
      return `• (${ago}) ${m.summary}`;
    });
    parts.push(`[Past Conversations]\n${memLines.join('\n')}`);
    sources.push('Long-term Memory');
  }

  return {
    memoryContext: parts.join('\n\n'),
    memorySources: sources,
    memoryCount: memories.length + entities.length,
  };
}

// ══════════════════════════════════════════════════════════════
// ── Clear Memory ────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════

/**
 * Clear all memory for a session (short-term, long-term, entities).
 * @param {string} sessionId
 * @returns {Promise<{ cleared: boolean, details: object }>}
 */
export async function clearMemory(sessionId) {
  const details = { shortTerm: false, longTerm: false, entities: false };

  // Clear short-term buffer
  if (shortTermBuffers.has(sessionId)) {
    shortTermBuffers.delete(sessionId);
    turnCounters.delete(sessionId);
    details.shortTerm = true;
  }

  if (!memoryReady || !qdrantClient) {
    return { cleared: details.shortTerm, details };
  }

  // Clear long-term memories from Qdrant
  try {
    await qdrantClient.delete(MEMORY_COLLECTION, {
      wait: true,
      filter: {
        must: [{ key: 'sessionId', match: { value: sessionId } }],
      },
    });
    details.longTerm = true;
  } catch (err) {
    console.error('[VoxFlow] Failed to clear long-term memory:', err.message);
  }

  // Clear entities from Qdrant
  try {
    await qdrantClient.delete(ENTITY_COLLECTION, {
      wait: true,
      filter: {
        must: [{ key: 'sessionId', match: { value: sessionId } }],
      },
    });
    details.entities = true;
  } catch (err) {
    console.error('[VoxFlow] Failed to clear entity memory:', err.message);
  }

  console.log(`[VoxFlow] 🗑️ Cleared memory for session ${sessionId.substring(0, 12)}...`, details);
  return { cleared: true, details };
}

// ══════════════════════════════════════════════════════════════
// ── Health Check ────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════

/**
 * Get memory system health info.
 */
export async function getMemoryHealth() {
  let memoryCollectionInfo = null;
  let entityCollectionInfo = null;

  if (memoryReady && qdrantClient) {
    try {
      memoryCollectionInfo = await qdrantClient.getCollection(MEMORY_COLLECTION);
    } catch {}
    try {
      entityCollectionInfo = await qdrantClient.getCollection(ENTITY_COLLECTION);
    } catch {}
  }

  return {
    ready: memoryReady,
    lastError,
    collections: {
      memory: memoryCollectionInfo ? {
        name: MEMORY_COLLECTION,
        pointCount: memoryCollectionInfo.points_count,
      } : null,
      entities: entityCollectionInfo ? {
        name: ENTITY_COLLECTION,
        pointCount: entityCollectionInfo.points_count,
      } : null,
    },
    activeBuffers: shortTermBuffers.size,
    checkedAt: new Date().toISOString(),
  };
}

// ══════════════════════════════════════════════════════════════
// ── User Preferences ────────────────────────────────────────
// ══════════════════════════════════════════════════════════════

/**
 * Update user preferences based on message content.
 * @param {string} sessionId
 * @param {string} message
 */
export function updatePreferences(sessionId, message) {
  if (!userPreferences.has(sessionId)) {
    userPreferences.set(sessionId, {});
  }
  const prefs = userPreferences.get(sessionId);

  // Simple keyword-based preference tracking
  const positiveWords = ['like', 'love', 'favorite', 'prefer', 'good', 'great', 'awesome'];
  const negativeWords = ['dislike', 'hate', 'bad', 'terrible', 'awful'];

  const lowerMsg = message.toLowerCase();
  for (const word of positiveWords) {
    if (lowerMsg.includes(word)) {
      // Extract topic after the word
      const parts = lowerMsg.split(word);
      if (parts[1]) {
        const topic = parts[1].trim().split(' ')[0];
        prefs[topic] = (prefs[topic] || 0) + 1;
      }
    }
  }
  for (const word of negativeWords) {
    if (lowerMsg.includes(word)) {
      const parts = lowerMsg.split(word);
      if (parts[1]) {
        const topic = parts[1].trim().split(' ')[0];
        prefs[topic] = (prefs[topic] || 0) - 1;
      }
    }
  }
}

/**
 * Get user preferences as a string for LLM prompt.
 * @param {string} sessionId
 * @returns {string}
 */
export function getPreferencesContext(sessionId) {
  const prefs = userPreferences.get(sessionId);
  if (!prefs || Object.keys(prefs).length === 0) return '';

  const positive = Object.entries(prefs).filter(([k, v]) => v > 0).map(([k, v]) => `${k} (+${v})`);
  const negative = Object.entries(prefs).filter(([k, v]) => v < 0).map(([k, v]) => `${k} (${v})`);

  let context = '';
  if (positive.length > 0) context += `User likes: ${positive.join(', ')}. `;
  if (negative.length > 0) context += `User dislikes: ${negative.join(', ')}. `;

  return context.trim();
}

// ══════════════════════════════════════════════════════════════
// ── Utilities ───────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════

/** Generate a unique numeric ID for Qdrant points. */
function generatePointId() {
  // Qdrant accepts unsigned 64-bit integers or UUIDs.
  // Using a timestamp-based approach with random suffix.
  return Math.floor(Date.now() * 1000 + Math.random() * 1000);
}

/** Format a timestamp into a human-friendly "time ago" string. */
function formatTimeAgo(timestamp) {
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
