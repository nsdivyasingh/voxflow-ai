/**
 * VoxFlow — Orchestrator (Core Decision Engine)
 *
 * For every user query:
 *   1. Detect intent
 *   2. Classify → KNOWLEDGE | ACTION | GENERAL
 *   3. Route to the right tool
 *   4. Generate a grounded, voice-friendly response
 *   5. Track pipeline metadata for transparency
 *
 * Rules:
 *   - NEVER skip retrieval for knowledge queries
 *   - NEVER hallucinate missing data
 *   - NEVER execute actions without confirmation
 */

import { detectIntent, classifyQuery } from './intentDetector.js';
import { getSession, recordTopic, storePendingAction, retrieveMemory, analyzeContext } from './sessionStore.js';
import { retrieve } from './retriever.js';
import { prepareAction } from './actionExecutor.js';
import { updatePreferences } from './memoryLayer.js';
import { generateResponse } from './responseGenerator.js';
import {
  recordTurn,
  recallAll,
  tickAndMaybeSummarize,
  extractAndStoreEntities,
  isMemoryReady,
} from './memoryLayer.js';
import { getRecentEmails, analyzeEmailsForPerson } from './emailInsights.js';
import { findBestContactByText } from './contactDirectory.js';

function looksLikeEmailInsightsQuery(message) {
  const m = message.toLowerCase();
  return (
    /\b(last|latest|recent)\b.*\b(email|emails|mail|mails)\b/.test(m)
    || /\b(email|emails|mail|mails)\b.*\b(last|latest|recent)\b/.test(m)
    || /\b\d+\b.*\b(email|emails|mail|mails)\b/.test(m)
    || /\b(email|emails|mail|mails)\b.*\b\d+\b/.test(m)
    || /\b(summarize|summary|analyze|analysis|discussion|deliverable|deliverables|action items|decisions)\b.*\b(email|emails|mail|mails)\b/.test(m)
    || /\b(email|emails|mail|mails)\b.*\b(with|from|to)\b/.test(m)
  );
}

function extractDays(message, fallback) {
  const m = message.toLowerCase();
  const numericCount = m.match(/\b(\d+)\s*(?:day|days)\b/);
  if (numericCount) return Math.max(1, Number(numericCount[1]));
  const numericMailCount = m.match(/\b(?:latest|last|recent)\s+(\d+)\s+(?:email|emails|mail|mails)\b/);
  if (numericMailCount) return Math.max(1, Math.min(60, Number(numericMailCount[1])));
  const explicitDays = m.match(/\b(?:last|past)\s+(\d+)\s+days?\b/);
  if (explicitDays) return Math.max(1, Number(explicitDays[1]));
  if (/\b(last|past)\s+week\b/.test(m)) return 7;
  if (/\b(last|past)\s+month\b/.test(m)) return 30;
  return fallback;
}

function extractEmailFromMessage(message) {
  const match = message.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return match ? match[0].toLowerCase() : '';
}

function extractPersonContext(message) {
  const lower = message.toLowerCase();
  const afterWith = lower.match(/\b(?:with|from|to)\s+([a-z0-9.\s_-]{2,80})/i);
  return afterWith?.[1]?.trim() || '';
}

function formatRecentEmailsReply(payload) {
  if (!payload?.messages?.length) {
    return `I couldn't find emails in the selected window.`;
  }

  const lines = payload.messages.slice(0, 8).map((msg, idx) => {
    const from = msg.from?.[0]?.address || 'unknown sender';
    const when = new Date(msg.date).toLocaleString();
    return `${idx + 1}. ${msg.subject} — from ${from} (${when})`;
  });

  return `I found ${payload.count} emails from the last ${payload.days} day(s).\n\n${lines.join('\n')}\n\nWant me to summarize any specific thread or person?`;
}

function formatPersonSummaryReply(payload) {
  const a = payload.analysis || {};
  const list = (title, values = []) =>
    values.length ? `${title}\n- ${values.slice(0, 6).join('\n- ')}` : `${title}\n- None identified`;

  return [
    `I analyzed ${payload.messageCount} emails with ${payload.personEmail} from the last ${payload.days} day(s).`,
    '',
    a.summary || 'No high-confidence summary available.',
    '',
    list('Key discussions:', a.discussionTopics || []),
    '',
    list('Deliverables completed:', a.deliverablesCompleted || []),
    '',
    list('Pending deliverables:', a.pendingDeliverables || []),
    '',
    list('Decisions:', a.decisions || []),
    '',
    list('Action items:', a.actionItems || []),
    '',
    list('Risks/blockers:', a.risksOrBlockers || []),
  ].join('\n');
}

/**
 * Main orchestration pipeline.
 *
 * @param {object} params
 * @param {string} params.message - User message
 * @param {Array}  params.history - Conversation history
 * @param {string} params.sessionId - Session identifier
 * @param {boolean} [params.debug=false] - Enable debug trace
 * @returns {Promise<object>} Response envelope
 */
export async function orchestrate({ message, history = [], sessionId = 'default', debug = false }) {
  const startTime = Date.now();

  // ── Step 0: Record user turn in memory ──
  recordTurn(sessionId, 'user', message);

  // ── Step 1: Intent Detection ──
  const intent = detectIntent(message);

  // ── Step 2: Update user preferences ──
  updatePreferences(sessionId, message);

  // ── Step 3: Query Classification ──
  const queryType = classifyQuery(intent, message);

  // ── Step 3: Get session & context ──
  const session = getSession(sessionId);
  const conversationContext = analyzeContext(history);

  // Record this topic in session memory
  recordTopic(session, intent, message);

  // ── Step 4: Route to tool ──
  let contextText = '';
  let sources = [];
  let action = null;
  let actionId = null;
  let toolUsed = 'reasoning';
  let retrievedAnswer = '';
  let retrievalInsights = {};
  let memoryContext = '';
  let memorySources = [];
  let memoryCount = 0;
  let directReply = '';

  // ── Step 4a: Recall relevant memories for context ──
  if (isMemoryReady() && queryType !== 'GENERAL') {
    try {
      const recalled = await recallAll(sessionId, message);
      memoryContext = recalled.memoryContext;
      memorySources = recalled.memorySources;
      memoryCount = recalled.memoryCount;
    } catch (err) {
      console.warn('[VoxFlow] Memory recall failed:', err.message);
    }
  }

  if (queryType === 'KNOWLEDGE') {
    toolUsed = 'retrieval';

    // Special case: conversation memory retrieval
    if (intent === 'memory') {
      // Combine session memory with long-term memory
      const sessionMemory = retrieveMemory(session);
      const parts = [];
      if (sessionMemory) {
        parts.push(`Recent topics:\n${sessionMemory}`);
      }
      if (memoryContext) {
        parts.push(memoryContext);
      }
      if (parts.length > 0) {
        contextText = `Here's what I remember:\n\n${parts.join('\n\n')}\n\nWould you like to revisit any of these topics?`;
        sources = ['Conversation Memory', ...memorySources];
      } else {
        contextText = '';
        sources = ['Conversation Memory'];
      }
    } else {
      // Knowledge base retrieval — NEVER skip this
      const retrieval = await retrieve(message);
      contextText = retrieval.contextText;
      sources = retrieval.sources;
      retrievedAnswer = retrieval.answer || '';
      retrievalInsights = retrieval.insights && typeof retrieval.insights === 'object'
        ? retrieval.insights
        : {};

      // If retrieval found nothing, downgrade tool to reasoning
      if (!contextText && !retrievedAnswer) {
        toolUsed = 'reasoning';
      }
    }
  } else if (queryType === 'ACTION') {
    toolUsed = 'api';

    // Special case: email inbox analytics and summaries routed directly through API.
    if (intent === 'email' && looksLikeEmailInsightsQuery(message)) {
      const days = extractDays(message, 7);
      let personEmail = extractEmailFromMessage(message);
      let resolvedPersonName = '';
      if (!personEmail) {
        const personContext = extractPersonContext(message) || message;
        const contact = findBestContactByText(personContext);
        if (contact?.email) {
          personEmail = contact.email;
          resolvedPersonName = contact.name;
        }
      }
      const wantsSummary = /\b(summarize|summary|analyze|analysis|discussion|deliverable|deliverables|action items|decisions|with|from|to)\b/i.test(message);

      try {
        if (wantsSummary) {
          if (!personEmail) {
            directReply = 'I can do that. Please include the person email address or a mapped name, for example: "summarize email discussions with name@company.com for last month".';
          } else {
            const summary = await analyzeEmailsForPerson({
              personEmail,
              days: extractDays(message, 30),
              limit: 120,
            });
            directReply = formatPersonSummaryReply(summary);
            if (resolvedPersonName) {
              directReply = `I resolved "${resolvedPersonName}" to ${personEmail}.\n\n${directReply}`;
            }
            sources = ['Inbox (IMAP)', 'OpenRouter Analysis'];
          }
        } else {
          const recent = await getRecentEmails({ days, limit: 25 });
          directReply = formatRecentEmailsReply(recent);
          sources = ['Inbox (IMAP)'];
        }
      } catch (err) {
        console.error('[VoxFlow] Email insights pipeline failed:', err?.message || err);
        directReply = `I couldn't fetch email insights right now: ${err?.message || 'unknown error'}`;
      }
    } else {
      // Prepare action but do NOT execute
      action = await prepareAction(intent, message);

      if (action) {
        // Store as pending — awaits user confirmation
        actionId = storePendingAction(session, action);
        action.id = actionId;
      }
    }
  }
  // GENERAL queries → no tool needed, just reasoning

  // ── Step 5: Generate Response ──
  let finalReply = '';
  let isStream = false;
  let responseStream = null;

  if (queryType === 'KNOWLEDGE' && intent === 'memory' && contextText) {
    finalReply = contextText;
  } else if (directReply) {
    finalReply = directReply;
  } else if (queryType === 'KNOWLEDGE' && retrievedAnswer) {
    // For Python-backed retrieval answers, avoid a second LLM generation call.
    finalReply = retrievedAnswer;
  } else {
    const genResult = await generateResponse({
      queryType,
      intent,
      message,
      contextText,
      memoryContext,
      action,
      history,
      conversationContext,
      sessionId,
    });
    
    isStream = genResult.isStream;
    if (isStream) {
      responseStream = genResult.stream;
    } else {
      finalReply = genResult.reply;
    }
  }

  // ── Step 6: Build response envelope ──
  const latencyMs = Date.now() - startTime;

  const response = {
    isStream,
    reply: finalReply,
    stream: responseStream,
    intent,
    queryType,
    toolUsed,
    sources: [...sources, ...memorySources],
    action: action ? {
      id: action.id,
      type: action.type,
      intent: action.intent,
      icon: action.icon,
      status: action.status,
      description: action.description,
      details: action.details,
      options: action.options,
      followUp: action.followUp,
      confirmMessage: action.confirmMessage,
    } : null,
    insights: retrievalInsights,
    memoryUsed: memoryCount > 0,
    memoryCount,
  };

  // ── Debug trace (only included when debug=true) ──
  if (debug) {
    response.debug = {
      intent,
      queryType,
      toolUsed,
      contextUsed: contextText ? contextText.substring(0, 200) + '...' : '(none)',
      contextLength: contextText.length,
      sourcesCount: sources.length,
      actionTaken: action ? action.type : '(none)',
      isFollowUp: conversationContext.isFollowUp,
      turnCount: conversationContext.turnCount,
      latencyMs,
      llmUsed: false, // Will be updated when LLM is available
      sessionTopics: session.topics.length,
    };
  }

  // ── Console logging ──
  const memTag = memoryCount > 0 ? ` | Memory: ${memoryCount} recalled` : '';
  console.log(
    `[VoxFlow] ${queryType} | Tool: ${toolUsed} | Intent: ${intent} | Latency: ${latencyMs}ms${memTag} | Msg: "${message.substring(0, 60)}"`
  );

  // ── Step 7: Post-response memory operations (fire-and-forget) ──
  // Record the assistant reply in short-term memory
  const replyForMemory = finalReply || '';
  if (replyForMemory) {
    recordTurn(sessionId, 'assistant', replyForMemory);
  }

  // Trigger periodic summarization and entity extraction (non-blocking)
  tickAndMaybeSummarize(sessionId).catch(() => {});
  extractAndStoreEntities(sessionId, message).catch(() => {});

  return response;
}
