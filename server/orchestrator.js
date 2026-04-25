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
import { generateResponse } from './responseGenerator.js';

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

  // ── Step 1: Intent Detection ──
  const intent = detectIntent(message);

  // ── Step 2: Query Classification ──
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

  if (queryType === 'KNOWLEDGE') {
    toolUsed = 'retrieval';

    // Special case: conversation memory retrieval
    if (intent === 'memory') {
      const memory = retrieveMemory(session);
      if (memory) {
        contextText = `Here's a summary of what we've discussed so far:\n${memory}\n\nWould you like to revisit any of these topics?`;
        sources = ['Conversation Memory'];
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

    // Prepare action but do NOT execute
    action = await prepareAction(intent, message);

    if (action) {
      // Store as pending — awaits user confirmation
      actionId = storePendingAction(session, action);
      action.id = actionId;
    }
  }
  // GENERAL queries → no tool needed, just reasoning

  // ── Step 5: Generate Response ──
  let finalReply = '';
  if (queryType === 'KNOWLEDGE' && intent === 'memory' && contextText) {
    finalReply = contextText;
  } else if (queryType === 'KNOWLEDGE' && retrievedAnswer) {
    // For Python-backed retrieval answers, avoid a second LLM generation call.
    finalReply = retrievedAnswer;
  } else {
    finalReply = await generateResponse({
      queryType,
      intent,
      message,
      contextText,
      action,
      history,
      conversationContext,
    });
  }

  // ── Step 6: Build response envelope ──
  const latencyMs = Date.now() - startTime;

  const response = {
    reply: finalReply,
    intent,
    queryType,
    toolUsed,
    sources,
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
  console.log(
    `[VoxFlow] ${queryType} | Tool: ${toolUsed} | Intent: ${intent} | Latency: ${latencyMs}ms | Msg: "${message.substring(0, 60)}"`
  );

  return response;
}
