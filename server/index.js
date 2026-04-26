/**
 * VoxFlow — Backend API Server
 * Express server with orchestrator-powered endpoints.
 *
 * Routes:
 *   POST /api/chat           → Main conversation endpoint (orchestrator pipeline)
 *   POST /api/action/confirm → Confirm a pending action
 *   POST /api/action/cancel  → Cancel a pending action
 *   GET  /api/health         → Health check
 */

import express from 'express';
import cors from 'cors';
import { orchestrate } from './orchestrator.js';
import { initLLM, isLLMAvailable } from './responseGenerator.js';
import { initQdrant, isQdrantReady, getRetrievalHealth } from './retriever.js';
import { initMemory, isMemoryReady, getMemoryHealth, clearMemory } from './memoryLayer.js';
import {
  getSession,
  confirmPendingAction,
  cancelPendingAction,
} from './sessionStore.js';
import { executeConfirmedAction } from './actionExecutor.js';
import { onReminderFired, getReminders, cancelReminder } from './reminderStore.js';
import { getRecentEmails, analyzeEmailsForPerson, syncEmails } from './emailInsights.js';
import { initCalendar, addCalendarEvent, getUpcomingEvents } from './calendarSync.js';

const app = express();
const PORT = 3001;

app.use(cors());
app.use(express.json());

// ── Load .env if available ──
try {
  const dotenv = await import('dotenv');
  const configFn = dotenv.config || dotenv.default?.config;
  if (configFn) {
    configFn({ path: new URL('../.env', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1') });
  }
} catch {
  // dotenv not installed — no problem, continue without it
}

// ── Initialize services on startup ──
await initLLM();
await initQdrant();
await initMemory();
await initCalendar();


// ══════════════════════════════════════════════════════════════
// ── POST /api/chat — Main Conversation Endpoint ─────────────
// ══════════════════════════════════════════════════════════════

app.post('/api/chat', async (req, res) => {
  try {
    const { message, history, sessionId, debug } = req.body;

    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'Missing or invalid message.' });
    }

    const enableDebug = debug === true || process.env.DEBUG_MODE === 'true';

    const response = await orchestrate({
      message: message.trim(),
      history: history || [],
      sessionId: sessionId || 'default',
      debug: enableDebug,
    });

    if (response.isStream && response.stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders(); // Establish SSE connection immediately

      // Send metadata first
      const metadata = { ...response };
      delete metadata.stream;
      delete metadata.isStream;
      res.write(`event: metadata\ndata: ${JSON.stringify(metadata)}\n\n`);

      // Stream text chunks
      for await (const chunk of response.stream) {
        res.write(`event: chunk\ndata: ${JSON.stringify({ text: chunk })}\n\n`);
      }

      // Signal completion
      res.write(`event: done\ndata: {}\n\n`);
      res.end();
    } else {
      // If not streaming (e.g. from cache or template fallback), we still send as SSE
      // so the frontend only needs to support one format, OR we can just return JSON.
      // But standardizing on SSE is usually easier for the frontend if it expects it.
      // Actually, if we return JSON here, the frontend fetch handles it differently.
      // Let's stick to SSE for all responses from this endpoint for consistency.
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();

      const metadata = { ...response };
      delete metadata.stream;
      delete metadata.isStream;
      res.write(`event: metadata\ndata: ${JSON.stringify(metadata)}\n\n`);
      res.write(`event: chunk\ndata: ${JSON.stringify({ text: response.reply })}\n\n`);
      res.write(`event: done\ndata: {}\n\n`);
      res.end();
    }

  } catch (err) {
    console.error('[VoxFlow] Server error:', err);
    // If headers already sent, we can't easily send 500 JSON.
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal server error.' });
    } else {
      res.write(`event: error\ndata: {"error":"Internal server error"}\n\n`);
      res.end();
    }
  }
});


// ══════════════════════════════════════════════════════════════
// ── POST /api/action/confirm — Confirm a Pending Action ─────
// ══════════════════════════════════════════════════════════════

app.post('/api/action/confirm', async (req, res) => {
  try {
    const { actionId, sessionId } = req.body;

    if (!actionId || !sessionId) {
      return res.status(400).json({ error: 'Missing actionId or sessionId.' });
    }

    const session = getSession(sessionId);
    const action = confirmPendingAction(session, actionId);

    if (!action) {
      return res.status(404).json({ error: 'Action not found or already processed.' });
    }

    // Execute the confirmed action
    const result = await executeConfirmedAction(action, sessionId);

    console.log(`[VoxFlow] ✅ Action confirmed: ${action.type} (${actionId})`);

    res.json({
      status: 'confirmed',
      action: {
        id: actionId,
        type: action.type,
        icon: action.icon,
      },
      result,
    });
  } catch (err) {
    console.error('[VoxFlow] Action confirm error:', err);
    res.status(500).json({ error: 'Failed to confirm action.' });
  }
});


// ══════════════════════════════════════════════════════════════
// ── POST /api/action/cancel — Cancel a Pending Action ───────
// ══════════════════════════════════════════════════════════════

app.post('/api/action/cancel', (req, res) => {
  try {
    const { actionId, sessionId } = req.body;

    if (!actionId || !sessionId) {
      return res.status(400).json({ error: 'Missing actionId or sessionId.' });
    }

    const session = getSession(sessionId);
    const action = cancelPendingAction(session, actionId);

    if (!action) {
      return res.status(404).json({ error: 'Action not found or already processed.' });
    }

    console.log(`[VoxFlow] ❌ Action cancelled: ${action.type} (${actionId})`);

    res.json({
      status: 'cancelled',
      action: {
        id: actionId,
        type: action.type,
      },
    });
  } catch (err) {
    console.error('[VoxFlow] Action cancel error:', err);
    res.status(500).json({ error: 'Failed to cancel action.' });
  }
});


// ══════════════════════════════════════════════════════════════
// ── GET /api/config — Public Config for Frontend ────────────
// ══════════════════════════════════════════════════════════════

app.get('/api/config', (req, res) => {
  res.json({
    vapi: {
      publicKey: process.env.VAPI_PUBLIC_KEY || '',
      assistantId: process.env.VAPI_ASSISTANT_ID || '',
      enabled: !!(process.env.VAPI_PUBLIC_KEY && process.env.VAPI_ASSISTANT_ID),
    },
  });
});


// ══════════════════════════════════════════════════════════════
// ── GET /api/reminders/events — SSE Stream for Reminders ────
// ══════════════════════════════════════════════════════════════

app.get('/api/reminders/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Send a heartbeat every 30s to keep the connection alive
  const heartbeat = setInterval(() => {
    res.write('event: heartbeat\ndata: {}\n\n');
  }, 30000);

  // Register for reminder events
  const unsubscribe = onReminderFired((event) => {
    res.write(`event: reminder\ndata: ${JSON.stringify(event)}\n\n`);
  });

  // Cleanup on disconnect
  req.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
  });

  console.log('[VoxFlow] 🔔 SSE reminder listener connected');
});


// ══════════════════════════════════════════════════════════════
// ── GET /api/reminders — List Active Reminders ──────────────
// ══════════════════════════════════════════════════════════════

app.get('/api/reminders', (req, res) => {
  const sessionId = req.query.sessionId || 'default';
  const reminders = getReminders(sessionId);
  res.json({ reminders });
});

app.post('/api/reminders/:id/cancel', (req, res) => {
  const reminderId = req.params.id;
  if (!reminderId) {
    return res.status(400).json({ error: 'Missing reminder id.' });
  }

  const cancelled = cancelReminder(reminderId);
  if (!cancelled) {
    return res.status(404).json({ error: 'Reminder not found.' });
  }

  return res.json({ status: 'cancelled', reminder: cancelled });
});

// ══════════════════════════════════════════════════════════════
// ── Email Insights Endpoints ─────────────────────────────────
// ══════════════════════════════════════════════════════════════

app.get('/api/email/recent', async (req, res) => {
  try {
    const days = Number(req.query.days || 7);
    const limit = Number(req.query.limit || 25);
    const data = await getRecentEmails({ days, limit });
    res.json({ status: 'ok', ...data });
  } catch (err) {
    console.error('[VoxFlow] Recent emails error:', err);
    res.status(500).json({
      status: 'error',
      error: err?.message || 'Failed to fetch recent emails.',
    });
  }
});

app.get('/api/email/person-summary', async (req, res) => {
  try {
    const personEmail = String(req.query.email || '').trim();
    const days = Number(req.query.days || 30);
    const limit = Number(req.query.limit || 120);

    if (!personEmail) {
      return res.status(400).json({
        status: 'error',
        error: 'Missing query param: email',
      });
    }

    const data = await analyzeEmailsForPerson({ personEmail, days, limit });
    res.json({ status: 'ok', ...data });
  } catch (err) {
    console.error('[VoxFlow] Person email summary error:', err);
    res.status(500).json({
      status: 'error',
      error: err?.message || 'Failed to analyze person emails.',
    });
  }
});


// ══════════════════════════════════════════════════════════════
// ── POST /api/calendar/add — Add Event to Calendar ──────────
// ══════════════════════════════════════════════════════════════

app.post('/api/calendar/add', async (req, res) => {
  try {
    const { summary, startTime, endTime, description } = req.body;
    const event = await addCalendarEvent(summary, new Date(startTime), new Date(endTime), description);
    res.json({ event });
  } catch (err) {
    console.error('[VoxFlow] Calendar add failed:', err?.message || err);
    res.status(500).json({ error: err?.message || 'Failed to add calendar event.' });
  }
});

// ══════════════════════════════════════════════════════════════
// ── GET /api/calendar/upcoming — Get Upcoming Events ────────
// ══════════════════════════════════════════════════════════════

app.get('/api/calendar/upcoming', async (req, res) => {
  try {
    const events = await getUpcomingEvents();
    res.json({ events });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════
// ── POST /api/email/sync — Sync Emails ──────────────────────
// ══════════════════════════════════════════════════════════════

app.post('/api/email/sync', async (req, res) => {
  try {
    const { days, limit } = req.body;
    const emails = await syncEmails({ days, limit });
    res.json({ synced: emails.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


app.get('/api/health', async (req, res) => {
  const retrieval = await getRetrievalHealth();

  res.json({
    status: 'ok',
    service: 'VoxFlow Orchestrator API',
    version: '3.2.0',
    architecture: 'Orchestrator Pipeline + Memory Layer',
    tools: ['retrieval', 'api', 'reasoning', 'memory'],
    llmAvailable: isLLMAvailable(),
    qdrantReady: isQdrantReady(),
    memoryReady: isMemoryReady(),
    retrieval,
    vapiEnabled: !!(process.env.VAPI_PUBLIC_KEY && process.env.VAPI_ASSISTANT_ID),
    timestamp: new Date().toISOString(),
  });
});

app.get('/api/health/retrieval', async (req, res) => {
  try {
    const retrieval = await getRetrievalHealth();
    res.json({
      status: 'ok',
      retrieval,
    });
  } catch (err) {
    res.status(500).json({
      status: 'error',
      error: err?.message || 'Failed to inspect retrieval health',
    });
  }
});

app.get('/api/health/memory', async (req, res) => {
  try {
    const memory = await getMemoryHealth();
    res.json({ status: 'ok', memory });
  } catch (err) {
    res.status(500).json({ status: 'error', error: err?.message || 'Failed to inspect memory health' });
  }
});


// ══════════════════════════════════════════════════════════════
// ── DELETE /api/memory/:sessionId — Clear Memory ────────────
// ══════════════════════════════════════════════════════════════

app.delete('/api/memory/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    if (!sessionId) {
      return res.status(400).json({ error: 'Missing sessionId.' });
    }

    const result = await clearMemory(sessionId);
    console.log(`[VoxFlow] 🗑️ Memory cleared for session: ${sessionId.substring(0, 16)}...`);

    res.json({
      status: 'cleared',
      sessionId: sessionId.substring(0, 16) + '...',
      details: result.details,
    });
  } catch (err) {
    console.error('[VoxFlow] Memory clear error:', err);
    res.status(500).json({ error: 'Failed to clear memory.' });
  }
});


// ── Start ──
app.listen(PORT, () => {
  const vapiStatus = process.env.VAPI_PUBLIC_KEY ? '✅ Vapi Voice' : '⚠️ Vapi not configured (browser fallback)';
  const qdrantStatus = isQdrantReady() ? '✅ Python Qdrant backend' : '⚠️ Qdrant not available (in-memory fallback)';

  const memoryStatus = isMemoryReady() ? '✅ Memory layer' : '⚠️ Memory not available (short-term only)';

  console.log(`[VoxFlow] 🚀 Orchestrator API v3.2 running on http://localhost:${PORT}`);
  console.log(`[VoxFlow] 🔧 Pipeline: Intent → Classify → Route → Memory → Generate`);
  console.log(`[VoxFlow] 🛠️  Tools: Retrieval | API | Reasoning | Memory`);
  console.log(`[VoxFlow] 🎙️  Voice: ${vapiStatus}`);
  console.log(`[VoxFlow] 🔍 Search: ${qdrantStatus}`);
  console.log(`[VoxFlow] 🧠 Memory: ${memoryStatus}`);
});
