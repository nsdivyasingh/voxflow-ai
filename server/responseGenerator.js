/**
 * VoxFlow — Response Generator
 * Generates voice-friendly responses using LLM API (Gemini/OpenAI)
 * with a smart template fallback when no API key is configured.
 *
 * Design:
 *  - Context available → ground response in retrieved context
 *  - No context → reason with uncertainty disclosure
 *  - Action prepared → confirm clearly with details
 *  - Always voice-first: 1–3 sentences, natural spoken language
 */

import { getPreferencesContext } from './memoryLayer.js';

// ══════════════════════════════════════════════════════════════
// ── LLM Integration ──────────────────────────────────────────
// ══════════════════════════════════════════════════════════════

let llmClient = null;

/**
 * Initialize the LLM provider if an API key is available.
 * Called once at server startup.
 */
export async function initLLM() {
  const isOpenRouter = !!process.env.OPENROUTER_API_KEY;
  const isGroq = !!process.env.GROQ_API_KEY;
  const isGemini = !!process.env.GEMINI_API_KEY;

  if (isOpenRouter) {
    try {
      const { default: Groq } = await import('groq-sdk');
      llmClient = {
        client: new Groq({ 
          apiKey: process.env.OPENROUTER_API_KEY, 
          baseURL: "https://openrouter.ai/api/v1",
          defaultHeaders: {
            "HTTP-Referer": "http://localhost:3000",
            "X-Title": "VoxFlow"
          }
        }),
        type: 'openrouter'
      };
      console.log('[VoxFlow] ✅ OpenRouter LLM initialized');
      return true;
    } catch (err) {
      console.warn('[VoxFlow] ⚠️ OpenRouter initialization failed:', err.message);
    }
  } else if (isGroq) {
    try {
      const { default: Groq } = await import('groq-sdk');
      llmClient = {
        client: new Groq({ apiKey: process.env.GROQ_API_KEY }),
        type: 'groq'
      };
      console.log('[VoxFlow] ✅ Groq LLM initialized');
      return true;
    } catch (err) {
      console.warn('[VoxFlow] ⚠️ Groq initialization failed:', err.message);
    }
  } else if (isGemini) {
    try {
      const { GoogleGenerativeAI } = await import('@google/generative-ai');
      const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
      llmClient = {
        client: genAI.getGenerativeModel({ model: 'gemini-2.0-flash' }),
        type: 'gemini'
      };
      console.log('[VoxFlow] ✅ Gemini LLM initialized');
      return true;
    } catch (err) {
      console.warn('[VoxFlow] ⚠️ Gemini initialization failed:', err.message);
    }
  }

  console.log('[VoxFlow] ℹ️ No LLM API key configured — using template fallback');
  return false;
}

/**
 * Check if LLM is available.
 */
export function isLLMAvailable() {
  return llmClient !== null;
}

// ══════════════════════════════════════════════════════════════
// ── LLM Response Generation ─────────────────────────────────
// ══════════════════════════════════════════════════════════════

const SYSTEM_PROMPT = `You are VoxFlow, a voice-first AI assistant. Follow these rules STRICTLY:

1. Keep responses SHORT — 1 to 3 sentences max.
2. Use natural spoken language — as if you're talking to a friend.
3. Never expose technical details (embeddings, APIs, tools, models).
4. If context is provided, base your answer ONLY on that context.
5. If no context is available, say "I couldn't find specific information on that, but here's what I know" and give a brief general answer.
6. Never fabricate facts or make up data.
7. End with a natural follow-up suggestion when appropriate.
8. Don't start with "Based on..." or "According to..." — just answer naturally.`;

const responseCache = new Map();
const CACHE_LIMIT = 100;

function getFromCache(key) {
  return responseCache.get(key);
}

function addToCache(key, value) {
  if (responseCache.size >= CACHE_LIMIT) {
    const firstKey = responseCache.keys().next().value;
    responseCache.delete(firstKey);
  }
  responseCache.set(key, value);
}

/**
 * Generate a response using the LLM.
 * @param {object} params
 * @returns {Promise<object>} { isStream: boolean, reply?: string, stream?: AsyncGenerator }
 */
async function llmGenerate({ queryType, intent, message, contextText, memoryContext, history, sessionId }) {
  if (!llmClient) return null;

  // Build memory preamble if available
  const memoryPreamble = memoryContext
    ? `\n\n[Relevant memories from past conversations]:\n${memoryContext}\n`
    : '';

  // Build preferences preamble
  const preferencesPreamble = getPreferencesContext(sessionId)
    ? `\n\n[User preferences]:\n${getPreferencesContext(sessionId)}\n`
    : '';

  let prompt = '';

  if (queryType === 'KNOWLEDGE' && contextText) {
    prompt = `${memoryPreamble}${preferencesPreamble}Context:\n${contextText}\n\nUser question: "${message}"\n\nAnswer the user's question based on the context above. If memory context is provided, use it to personalize your answer. Be concise and voice-friendly.`;
  } else if (queryType === 'ACTION') {
    prompt = `${memoryPreamble}${preferencesPreamble}The user wants to perform an action (${intent}). Their message: "${message}"\n\nAcknowledge the request naturally, and ask for any missing details needed to complete the action. Be concise.`;
  } else {
    prompt = `${memoryPreamble}${preferencesPreamble}User message: "${message}"\n\nRespond naturally and concisely as a friendly voice assistant. If memory context is provided, use it to personalize your response.`;
  }

  const cacheKey = `${queryType}-${intent}-${message}`;
  const cached = getFromCache(cacheKey);
  if (cached) {
    console.log('[VoxFlow] ⚡ Cache hit for query:', message.substring(0, 30));
    return { isStream: false, reply: cached };
  }

  try {
    const fullPrompt = `${SYSTEM_PROMPT}\n\n${prompt}`;
    let chat;
    if (llmClient.type === 'openrouter') {
      const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "http://localhost:3000",
          "X-Title": "VoxFlow"
        },
        body: JSON.stringify({
          model: "google/gemma-3-27b-it:free",
          messages: [{ role: "user", content: fullPrompt }],
          temperature: 0.3
        })
      });
      if (!response.ok) {
        throw new Error(`OpenRouter API error: ${response.status} ${await response.text()}`);
      }
      const data = await response.json();
      return { isStream: false, reply: data.choices[0].message.content };
    } else if (llmClient.type === 'groq') {
      // Groq does not support stream in the same way here easily, so we fallback to standard 
      const response = await llmClient.client.chat.completions.create({
        messages: [{ role: 'user', content: fullPrompt }],
        model: 'llama-3.3-70b-versatile',
        temperature: 0.3,
      });
      return { isStream: false, reply: response.choices[0].message.content };
    } else {
      chat = llmClient.client.startChat({ history: [] });
    }

    // Wrap in a timeout so rate-limit / network errors don't hang forever.
    const LLM_TIMEOUT_MS = 15_000;
    const result = await Promise.race([
      chat.sendMessageStream(fullPrompt),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('LLM request timed out')), LLM_TIMEOUT_MS)
      ),
    ]);

    // Wrap the async generator so stream-time errors are caught gracefully
    // instead of bubbling up to the SSE handler in index.js.
    async function* generateAndBuffer() {
      let fullText = '';
      try {
        for await (const chunk of result.stream) {
          const text = chunk.text();
          fullText += text;
          yield text;
        }
        addToCache(cacheKey, truncateForVoice(fullText));
      } catch (streamErr) {
        console.error('[VoxFlow] LLM stream error:', streamErr.message);
        // If we already yielded some text, just end the stream gracefully.
        // If nothing was yielded yet, yield a fallback message.
        if (!fullText) {
          yield "I'm having trouble generating a response right now. Let me try again in a moment.";
        }
      }
    }

    return { isStream: true, stream: generateAndBuffer() };
  } catch (err) {
    console.error('[VoxFlow] LLM generation error:', err.message);
    return null; // Fall through to template
  }
}

/**
 * Truncate a response to be voice-friendly (max ~3 sentences).
 */
function truncateForVoice(text, maxSentences = 3) {
  const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];
  if (sentences.length <= maxSentences) return text.trim();
  return sentences.slice(0, maxSentences).join(' ').trim();
}

// ══════════════════════════════════════════════════════════════
// ── Template Fallback Engine ─────────────────────────────────
// ══════════════════════════════════════════════════════════════

const STATIC_RESPONSES = {
  greeting: [
    "Hey! How can I help you today?",
    "Hello there! What can I do for you?",
    "Hi! I'm ready to help. What do you need?",
    "Hey! Good to hear from you. What's on your mind?",
  ],
  farewell: [
    "Take care! Let me know if you need anything else.",
    "Goodbye! Have a great day.",
    "See you later! I'll be here whenever you need me.",
  ],
  thanks: [
    "You're welcome! Anything else I can help with?",
    "Happy to help! Let me know if there's more.",
    "No problem at all! What else do you need?",
  ],
  capabilities: [
    "I'm VoxFlow, your voice-first AI assistant! I can help you with quite a bit — retrieve project updates, search for information, set reminders, schedule meetings, draft emails, take notes, and answer questions. I can also tell you jokes, check the time, and even remember our past conversations. What would you like to try?",
    "Great question! I can retrieve knowledge from your project data, set reminders, schedule meetings, draft emails, take notes, search for info, tell jokes, and remember what we've talked about. Just ask me anything or tap the mic to speak!",
    "I'm your voice-first AI assistant! I can search your project data for updates and blockers, set reminders, manage your schedule, compose emails, take notes, and hold natural conversations. I also remember our past chats so I can be more helpful over time. What do you need?",
  ],
  time: () => {
    const now = new Date();
    return `It's currently ${now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })}. Anything else?`;
  },
  date: () => {
    const now = new Date();
    return `Today is ${now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}. What else can I help with?`;
  },
  joke: [
    "Why don't scientists trust atoms? Because they make up everything!",
    "I told my computer I needed a break. Now it won't stop sending me vacation ads.",
    "Why did the developer go broke? Because he used up all his cache!",
    "What do you call a fake noodle? An impasta!",
    "Why do programmers prefer dark mode? Because the light attracts bugs!",
  ],
  name: [
    "I'm VoxFlow — your voice-first AI assistant. I'm here to help you get things done through conversation. What do you need?",
  ],
  status: [
    "I'm doing great, thanks for asking! Ready to help you with whatever you need.",
    "All systems go! What can I help you with?",
  ],
};

const GENERAL_FALLBACK = [
  "Interesting! Could you give me a bit more detail so I can help you better?",
  "That's a great question. Could you rephrase or add more context so I can give you a solid answer?",
  "Got it. I want to make sure I get this right — can you tell me a bit more?",
  "I'd love to help with that! Could you elaborate a little?",
];

const NO_CONTEXT_RESPONSES = [
  "I couldn't find specific information on that, but I'm happy to help if you can give me more details.",
  "I don't have specific knowledge about that topic, but feel free to ask something else or give me more context.",
  "I wasn't able to find relevant information for that. Want me to try a different angle?",
];

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * Generate a response using templates (fallback when no LLM).
 */
function templateGenerate({ queryType, intent, message, contextText, action, conversationContext }) {
  // ── Static responses (greeting, farewell, etc.) ──
  const staticSet = STATIC_RESPONSES[intent];
  if (staticSet) {
    if (typeof staticSet === 'function') return staticSet();
    return pickRandom(staticSet);
  }

  // ── Knowledge query with context ──
  if (queryType === 'KNOWLEDGE' && contextText) {
    const followUp = conversationContext?.isFollowUp
      ? " Is there anything specific you'd like me to elaborate on?"
      : " What would you like to do next?";
    return contextText.split('\n\n')[0] + followUp;
  }

  // ── Knowledge query without context ──
  if (queryType === 'KNOWLEDGE' && !contextText) {
    return pickRandom(NO_CONTEXT_RESPONSES);
  }

  // ── Action query ──
  if (queryType === 'ACTION' && action) {
    return action.followUp;
  }

  // ── Context-aware follow-up ──
  if (conversationContext?.isFollowUp && conversationContext.lastTopic) {
    return `Building on what we were discussing — ${pickRandom(GENERAL_FALLBACK)}`;
  }

  // ── General fallback ──
  return pickRandom(GENERAL_FALLBACK);
}

// ══════════════════════════════════════════════════════════════
// ── Public API ───────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════

/**
 * Generate the final response.
 * Uses LLM if available, falls back to templates.
 *
 * @param {object} params
 * @param {'KNOWLEDGE'|'ACTION'|'GENERAL'} params.queryType
 * @param {string} params.intent
 * @param {string} params.message
 * @param {string} [params.contextText] - Retrieved context for grounding
 * @param {object} [params.action] - Prepared action descriptor
 * @param {Array}  [params.history] - Conversation history
 * @param {object} [params.conversationContext] - Analyzed context
 * @returns {Promise<object>} { isStream: boolean, reply?: string, stream?: AsyncGenerator }
 */
export async function generateResponse(params) {
  const { queryType, intent, message, contextText, memoryContext, action, history, conversationContext, sessionId } = params;

  // Try LLM first
  if (isLLMAvailable() && !STATIC_RESPONSES[intent]) {
    const llmReply = await llmGenerate({ queryType, intent, message, contextText, memoryContext, history, sessionId });
    if (llmReply) return llmReply;
  }

  // Fallback to templates
  const fallbackReply = templateGenerate({ queryType, intent, message, contextText, action, conversationContext });
  return { isStream: false, reply: fallbackReply };
}
