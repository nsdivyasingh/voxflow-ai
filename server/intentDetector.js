/**
 * VoxFlow — Intent Detector & Query Classifier
 * Detects user intent via pattern matching and classifies queries
 * into KNOWLEDGE, ACTION, or GENERAL categories for the orchestrator.
 */

// ── Intent Patterns ──────────────────────────────────────────
const INTENTS = [
  {
    name: 'greeting',
    patterns: [
      /^(hi+|hello+|hey+|heya|howdy|sup|yo)\b/i,
      /\b(good morning|good afternoon|good evening)\b/i,
      /^(hello|hi|hey)[\s,!.]*(there|team|voxflow|assistant)?\b/i,
      /^(how are you|how are u|how's it going|how is it going)\b/i,
    ],
  },
  { name: 'farewell',     patterns: [/^(bye|goodbye|see you|later|take care|good night)\b/i] },
  { name: 'thanks',       patterns: [/\b(thanks|thank you|appreciate|cheers)\b/i] },
  { name: 'capabilities', patterns: [/\b(what can you do|help me|capabilities|features|how do you work|what do you do)\b/i] },
  { name: 'weather',      patterns: [/\b(weather|temperature|forecast|rain|sunny|cloudy|snow)\b/i] },
  { name: 'time',         patterns: [/\b(what time|current time|time is it|what.s the time)\b/i] },
  { name: 'date',         patterns: [/\b(what date|today.s date|what day|current date)\b/i] },
  { name: 'reminder',     patterns: [/\b(remind|reminder|set a reminder|don.t forget)\b/i] },
  { name: 'schedule',     patterns: [/\b(schedule|meeting|appointment|calendar|event|book a)\b/i] },
  { name: 'email',        patterns: [/\b(email|send.*mail|compose.*email|write.*email|apply.*leave|seek.*leave|request.*leave)\b/i] },
  { name: 'search',       patterns: [/\b(search|look up|find|google|look for|search for)\b/i] },
  { name: 'joke',         patterns: [/\b(joke|funny|make me laugh|tell me something funny)\b/i] },
  { name: 'name',         patterns: [/\b(your name|who are you|what are you|introduce yourself)\b/i] },
  { name: 'status',       patterns: [/\b(how are you|how.s it going|what.s up|you doing)\b/i] },
  { name: 'calculate',    patterns: [/\b(calculate|compute|what is \d|math|add|subtract|multiply|divide)\b/i] },
  { name: 'news',         patterns: [/\b(news|headlines|what.s happening|current events)\b/i] },
  { name: 'music',        patterns: [/\b(play music|song|playlist|music)\b/i] },
  { name: 'note',         patterns: [/\b(take a note|save this|note down|remember this)\b/i] },
  { name: 'memory',       patterns: [
    /\b(what did we|what we discussed|our conversation|previous|last time|discussed yesterday|talked about)\b/i,
    /\b(do you remember|you remember|recall|what did i say|what i said|what i told you|my name is|what.s my name|my preference|my favorite)\b/i,
    /\b(remember when|we talked|earlier i|previously i|last session|past conversation)\b/i,
  ] },
];

// ── Query Type Categories ────────────────────────────────────
const KNOWLEDGE_INTENTS = new Set([
  'weather', 'search', 'news', 'calculate', 'music', 'memory',
]);

const ACTION_INTENTS = new Set([
  'reminder', 'schedule', 'email', 'note',
]);

const GENERAL_INTENTS = new Set([
  'greeting', 'farewell', 'thanks', 'joke', 'name', 'status', 'time', 'date', 'capabilities',
]);

/**
 * Detect intent from user message.
 * @param {string} message
 * @returns {string} intent name (e.g. 'greeting', 'weather', 'general')
 */
export function detectIntent(message) {
  const normalizedMessage = message
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

  for (const intent of INTENTS) {
    for (const pattern of intent.patterns) {
      if (pattern.test(normalizedMessage)) {
        return intent.name;
      }
    }
  }

  // Catch short conversational niceties that often miss strict patterns.
  if (/^(gm|gn|good day|hiya|hii+|helloo+)\b/.test(normalizedMessage)) {
    return 'greeting';
  }

  // Fallback: Token overlap check (Fuzzy matching)
  const tokens = normalizedMessage.split(' ').filter(t => t.length > 2);
  if (tokens.length > 0) {
    let bestIntent = 'general';
    let maxMatches = 0;

    const keywordsMap = {
      weather: ['weather', 'temperature', 'forecast', 'rain', 'sunny', 'climate', 'hot', 'cold'],
      schedule: ['schedule', 'meeting', 'appointment', 'calendar', 'event', 'book'],
      email: ['email', 'mail', 'compose', 'inbox'],
      reminder: ['remind', 'reminder', 'alert', 'notify', 'forget'],
      search: ['search', 'look', 'find', 'google', 'know'],
      joke: ['joke', 'funny', 'laugh'],
      calculate: ['calculate', 'math', 'add', 'subtract', 'multiply', 'divide', 'compute'],
      news: ['news', 'headlines', 'happening', 'breaking'],
      music: ['music', 'song', 'playlist', 'play', 'spotify', 'track'],
      memory: ['discussed', 'yesterday', 'talked', 'remember', 'last', 'recall', 'name', 'preference', 'favorite', 'earlier', 'previous', 'session']
    };

    for (const [intentName, keywords] of Object.entries(keywordsMap)) {
      let matches = 0;
      for (const token of tokens) {
        if (keywords.includes(token)) {
          matches++;
        }
      }
      if (matches > maxMatches) {
        maxMatches = matches;
        bestIntent = intentName;
      }
    }
    
    if (maxMatches > 0) {
      return bestIntent;
    }
  }

  return 'general';
}

/**
 * Classify an intent into a query type for the orchestrator.
 * @param {string} intent
 * @param {string} [message]
 * @returns {'KNOWLEDGE'|'ACTION'|'GENERAL'}
 */
export function classifyQuery(intent, message = '') {
  if (KNOWLEDGE_INTENTS.has(intent)) return 'KNOWLEDGE';
  if (ACTION_INTENTS.has(intent))    return 'ACTION';

  // If the message looks like an information request, prefer retrieval.
  // This ensures user questions route through the Qdrant backend.
  const normalized = message.toLowerCase().trim();
  const questionLike = /\?$/.test(normalized)
    || /^(what|why|how|when|where|who|which|explain|tell me|give me|show me|summarize|status of)\b/.test(normalized);
  if (intent === 'general' && questionLike) return 'KNOWLEDGE';

  return 'GENERAL';
}

/**
 * Get all defined intents (useful for debug/health endpoints).
 */
export function getIntentList() {
  return INTENTS.map(i => i.name);
}
