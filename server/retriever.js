/**
 * VoxFlow — Knowledge Retriever
 * Retrieves relevant knowledge using Qdrant vector search with Python backend.
 * Falls back to in-memory TF-IDF-like search if Python backend is not configured.
 */

import { QdrantClient } from '@qdrant/js-client-rest';
import { GoogleGenerativeAI } from '@google/generative-ai';

function getRetrieverConfig() {
  return {
    qdrantUrl: process.env.QDRANT_URL,
    qdrantApiKey: process.env.QDRANT_API_KEY,
    geminiApiKey: process.env.GEMINI_API_KEY,
    qdrantCollection: process.env.QDRANT_COLLECTION || 'voxflow-kb',
    pythonApiUrl: process.env.PYTHON_QDRANT_URL || 'http://127.0.0.1:8001',
  };
}

// ══════════════════════════════════════════════════════════════
// ── Qdrant + Gemini Retrieval ─────────────────────────────────
// ══════════════════════════════════════════════════════════════

let qdrantReady = false;
let qdrantClient = null;
let embeddingModel = null;
let lastRetrieverPath = 'in_memory';
let lastDirectError = null;
let lastPythonError = null;

/**
 * Initialize / Check Python Backend.
 * Called once at server startup.
 */
export async function initQdrant() {
  console.log('[VoxFlow] ℹ️ Checking direct Qdrant retrieval setup...');
  const {
    qdrantUrl,
    qdrantApiKey,
    geminiApiKey,
    qdrantCollection,
  } = getRetrieverConfig();

  if (!qdrantUrl || !qdrantApiKey || !geminiApiKey) {
    qdrantReady = false;
    lastRetrieverPath = 'in_memory';
    lastDirectError = 'Missing Qdrant/Gemini env vars';
    console.warn('[VoxFlow] ⚠️ Missing Qdrant/Gemini env vars, using fallback retriever');
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

    // Validate target collection exists and is reachable.
    await qdrantClient.getCollection(qdrantCollection);
    qdrantReady = true;
    lastRetrieverPath = 'direct_qdrant';
    lastDirectError = null;
    console.log(`[VoxFlow] ✅ Direct Qdrant retrieval enabled (${qdrantCollection})`);
    return true;
  } catch (err) {
    qdrantReady = false;
    lastDirectError = err?.message || String(err);
    lastRetrieverPath = 'in_memory';
    console.warn('[VoxFlow] ⚠️ Direct Qdrant init failed, using fallback retriever:', err.message);
    return false;
  }
}

/**
 * Check if Qdrant is ready.
 */
export function isQdrantReady() {
  return qdrantReady;
}

/**
 * Generate embedding for text
 * Not used natively anymore - backend handles it.
 * @param {string} text
 * @returns {Promise<number[]>}
 */
export async function embedText(text) {
  throw new Error('Embeddings handled by Python backend');
}

/**
 * Search Qdrant directly using Gemini embeddings.
 * @param {string} message - User query
 * @param {number} topK - Number of results
 * @returns {Promise<{answer: string, context: Array, insights: Array, results: Array, contextText: string, sources: string[]}>}
 */
async function qdrantRetrieve(message, topK = 3) {
  try {
    const { qdrantCollection } = getRetrieverConfig();
    if (!qdrantClient || !embeddingModel) {
      throw new Error('Direct Qdrant clients not initialized');
    }

    const embedRes = await embeddingModel.embedContent(message);
    const vector = embedRes?.embedding?.values;
    if (!Array.isArray(vector) || vector.length === 0) {
      throw new Error('Failed to generate query embedding');
    }

    const searchResults = await qdrantClient.search(qdrantCollection, {
      vector,
      limit: Math.max(1, topK),
      with_payload: true,
    });

    const results = (searchResults || []).map((result) => {
      const payload = result?.payload || {};
      const normalizedText = payload.text || payload.content || '';
      return {
        ...payload,
        text: normalizedText,
        score: result?.score,
      };
    }).filter(item => item.text);

    const context = results;
    const insights = {};
    const answer = '';
    const contextText = results.map(r => r.text).join('\n\n');
    const sources = [...new Set(results.map(r => r.source || 'Qdrant'))];

    lastRetrieverPath = 'direct_qdrant';
    lastDirectError = null;
    console.log(`[VoxFlow] 🔍 Qdrant query: "${message}" (${results.length} hits)`);
    return { answer, context, insights, results, contextText, sources };
  } catch (err) {
    lastDirectError = err?.message || String(err);
    console.error('[VoxFlow] Direct Qdrant search error:', err.message);

    // Optional secondary fallback via Python API if configured.
    const { pythonApiUrl } = getRetrieverConfig();
    if (pythonApiUrl) {
      try {
        const response = await fetch(`${pythonApiUrl}/ask?q=${encodeURIComponent(message)}`);
        if (response.ok) {
          const data = await response.json();
          const context = Array.isArray(data.context) ? data.context : [];
          const insights = data.insights && typeof data.insights === 'object' ? data.insights : {};
          const answer = typeof data.answer === 'string' ? data.answer : '';
          const results = context;
          const contextText = results.map(r => r.text || r.content || '').join('\n\n');
          const sources = [...new Set(results.map(r => r.source || 'Python Qdrant Backend'))];
          lastRetrieverPath = 'python_backend';
          lastPythonError = null;
          console.log(`[VoxFlow] 🔁 Fallback Python backend query: ${data.refined_query || message}`);
          return { answer, context, insights, results, contextText, sources };
        }
        lastPythonError = `HTTP ${response.status}`;
      } catch (pythonErr) {
        lastPythonError = pythonErr?.message || String(pythonErr);
        console.error('[VoxFlow] Python fallback search error:', pythonErr.message);
      }
    }

    lastRetrieverPath = 'in_memory';
    return inMemoryRetrieve(message, topK);
  }
}


// ══════════════════════════════════════════════════════════════
// ── In-Memory Fallback ───────────────────────────────────────
// ══════════════════════════════════════════════════════════════

const KNOWLEDGE_BASE = [
  {
    id: 'kb-capabilities',
    topic: 'capabilities',
    keywords: ['can you do', 'help', 'capabilities', 'features', 'what do you do', 'how do you work'],
    content: 'VoxFlow is a voice-first AI assistant. I can set reminders, schedule meetings, draft emails, take notes, search for information, tell jokes, check the time and date, retrieve news, and play music. I use a combination of knowledge retrieval, reasoning, and external API integrations to serve you.',
    source: 'VoxFlow Documentation',
  },
  {
    id: 'kb-weather',
    topic: 'weather',
    keywords: ['weather', 'temperature', 'forecast', 'rain', 'sunny', 'cloudy', 'snow', 'climate'],
    content: "I can look up real-time weather data for any city. Just tell me the location, and I'll fetch the current conditions and forecast. I integrate with weather APIs to provide accurate temperature, humidity, wind, and precipitation info.",
    source: 'Weather Module',
  },
  {
    id: 'kb-scheduling',
    topic: 'scheduling',
    keywords: ['schedule', 'meeting', 'appointment', 'calendar', 'event', 'book'],
    content: "I can create, view, and manage calendar events. Tell me the event name, date, time, and any attendees. I'll confirm before adding it to your calendar. I support recurring events and can check for conflicts.",
    source: 'Calendar Integration',
  },
  {
    id: 'kb-email',
    topic: 'email',
    keywords: ['email', 'mail', 'compose', 'send', 'draft', 'inbox'],
    content: "I can compose and send emails on your behalf. Provide the recipient, subject, and body — I'll draft it for you to review before sending. I can also summarize recent emails if needed.",
    source: 'Email Integration',
  },
  {
    id: 'kb-reminders',
    topic: 'reminders',
    keywords: ['remind', 'reminder', "don't forget", 'alert', 'notify'],
    content: "I can set time-based and location-based reminders. Just tell me what to remind you about and when. I'll confirm the details and notify you at the right time.",
    source: 'Reminder System',
  },
  {
    id: 'kb-notes',
    topic: 'notes',
    keywords: ['note', 'save', 'note down', 'remember this', 'jot'],
    content: "I can take and organize notes for you. Dictate or type your thoughts, and I'll save them with timestamps. You can retrieve notes later by topic or keyword.",
    source: 'Notes Module',
  },
  {
    id: 'kb-news',
    topic: 'news',
    keywords: ['news', 'headlines', 'current events', "what's happening", 'breaking'],
    content: "I can fetch the latest news headlines across categories — tech, business, sports, science, entertainment, and world news. Ask for a specific category or I'll give you a general roundup.",
    source: 'News API',
  },
  {
    id: 'kb-music',
    topic: 'music',
    keywords: ['music', 'song', 'playlist', 'play', 'track', 'album'],
    content: 'I can help you find and play music. Tell me a genre, artist, mood, or specific song. I can create playlists, queue tracks, and control playback.',
    source: 'Music Integration',
  },
  {
    id: 'kb-math',
    topic: 'math',
    keywords: ['calculate', 'compute', 'math', 'add', 'subtract', 'multiply', 'divide', 'percentage'],
    content: 'I can perform calculations, unit conversions, and basic math operations. Just give me the numbers and the operation. I support arithmetic, percentages, and common conversions.',
    source: 'Calculator Engine',
  },
];

function tokenize(text) {
  return text.toLowerCase().replace(/[^\w\s]/g, '').split(/\s+/).filter(Boolean);
}

function termFrequency(tokens) {
  const freq = {};
  for (const t of tokens) freq[t] = (freq[t] || 0) + 1;
  const max = Math.max(...Object.values(freq));
  for (const t in freq) freq[t] /= max;
  return freq;
}

function inMemoryRetrieve(message, topK = 3) {
  const lower = message.toLowerCase();
  const queryTokens = tokenize(message);
  const queryTF = termFrequency(queryTokens);
  const results = [];

  for (const entry of KNOWLEDGE_BASE) {
    let score = 0;
    for (const kw of entry.keywords) {
      if (lower.includes(kw)) score += 3;
    }
    const entryTokens = tokenize(entry.content + ' ' + entry.keywords.join(' '));
    const entryTF = termFrequency(entryTokens);
    for (const token of queryTokens) {
      if (entryTF[token]) score += queryTF[token] * entryTF[token];
    }
    if (score > 0) {
      results.push({ id: entry.id, topic: entry.topic, content: entry.content, source: entry.source, score });
    }
  }

  results.sort((a, b) => b.score - a.score);
  const top = results.slice(0, topK);

  if (top.length === 0) {
    return { answer: '', context: [], insights: {}, results: [], contextText: '', sources: [] };
  }

  return {
    answer: '',
    context: [],
    insights: {},
    results: top,
    contextText: top.map(r => r.content).join('\n\n'),
    sources: [...new Set(top.map(r => r.source))],
  };
}


// ══════════════════════════════════════════════════════════════
// ── Public API ───────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════

/**
 * Retrieve relevant knowledge.
 * Priority: 1) Python backend (has real project data), 2) direct Qdrant, 3) in-memory fallback.
 * @param {string} message
 * @param {number} topK
 * @returns {Promise<{answer: string, context: Array, insights: object, results: Array, contextText: string, sources: string[]}>}
 */
export async function retrieve(message, topK = 3) {
  // ── Try Python backend first (has real project data) ──
  const { pythonApiUrl } = getRetrieverConfig();
  if (pythonApiUrl) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30_000);
      const response = await fetch(`${pythonApiUrl}/ask?q=${encodeURIComponent(message)}`, {
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (response.ok) {
        const data = await response.json();
        const context = Array.isArray(data.context) ? data.context : [];
        const insights = data.insights && typeof data.insights === 'object' ? data.insights : {};
        const answer = typeof data.answer === 'string' ? data.answer : '';
        const results = context;
        const contextText = results.map(r => r.text || r.content || '').join('\n\n');
        const sources = [...new Set(results.map(r => r.source || 'Project Data'))];
        lastRetrieverPath = 'python_backend';
        lastPythonError = null;
        console.log(`[VoxFlow] 🐍 Python backend query: "${data.refined_query || message}" (${results.length} results)`);
        return { answer, context, insights, results, contextText, sources };
      }
      lastPythonError = `HTTP ${response.status}`;
    } catch (pythonErr) {
      lastPythonError = pythonErr?.message || String(pythonErr);
      console.warn('[VoxFlow] ⚠️ Python backend unavailable:', lastPythonError);
    }
  }

  // ── Try direct Qdrant ──
  if (qdrantReady) {
    try {
      return await qdrantRetrieve(message, topK);
    } catch (err) {
      console.warn('[VoxFlow] ⚠️ Direct Qdrant failed, using in-memory fallback');
    }
  }

  // ── In-memory fallback ──
  lastRetrieverPath = 'in_memory';
  return inMemoryRetrieve(message, topK);
}

export async function getRetrievalHealth() {
  const { qdrantCollection, pythonApiUrl } = getRetrieverConfig();

  let pythonBackendReachable = false;
  let pythonStatusCode = null;
  if (pythonApiUrl) {
    try {
      const response = await fetch(`${pythonApiUrl}/docs`, {
        signal: AbortSignal.timeout(1500),
      });
      pythonBackendReachable = response.ok;
      pythonStatusCode = response.status;
    } catch {
      pythonBackendReachable = false;
    }
  }

  return {
    activePath: lastRetrieverPath,
    directQdrantReady: qdrantReady,
    collection: qdrantCollection,
    pythonBackendConfigured: Boolean(pythonApiUrl),
    pythonBackendReachable,
    pythonStatusCode,
    lastDirectError,
    lastPythonError,
    checkedAt: new Date().toISOString(),
  };
}

/**
 * Get the knowledge base entries (used by seed script).
 */
export function getKnowledgeBase() {
  return KNOWLEDGE_BASE;
}
