/**
 * VoxFlow — Reminder Store & Scheduler
 * Stores reminders in-memory with a timer-based scheduler.
 * Fires callbacks when reminders come due.
 * Supports natural language date/time parsing.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ── Reminder Storage ─────────────────────────────────────────
// Map<reminderId, ReminderObject>
const reminders = new Map();
let nextId = 1;

// Active timers: Map<reminderId, timeoutId>
const timers = new Map();

// Listeners for fired reminders (SSE clients)
const listeners = new Set();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REMINDER_DB_PATH = path.join(__dirname, 'reminders.json');

function persistReminders() {
  try {
    const payload = {
      nextId,
      reminders: [...reminders.values()],
    };
    fs.writeFileSync(REMINDER_DB_PATH, JSON.stringify(payload, null, 2), 'utf8');
  } catch (err) {
    console.error('[VoxFlow] Failed to persist reminders:', err.message || err);
  }
}

function restoreReminders() {
  try {
    if (!fs.existsSync(REMINDER_DB_PATH)) return;
    const raw = fs.readFileSync(REMINDER_DB_PATH, 'utf8');
    if (!raw.trim()) return;

    const parsed = JSON.parse(raw);
    const persistedReminders = Array.isArray(parsed?.reminders) ? parsed.reminders : [];
    nextId = Number.isInteger(parsed?.nextId) && parsed.nextId > 0 ? parsed.nextId : 1;

    const now = Date.now();
    for (const reminder of persistedReminders) {
      if (!reminder?.id || !reminder?.when) continue;
      const fireAt = new Date(reminder.when).getTime();
      if (Number.isNaN(fireAt)) continue;
      if (fireAt <= now) {
        // Fire overdue reminders on startup
        fireReminder(reminder);
      } else {
        reminder.status = 'scheduled';
        reminders.set(reminder.id, reminder);
        scheduleReminder(reminder);
      }
    }

    console.log(`[VoxFlow] 🔔 Restored ${reminders.size} reminder(s) from disk`);
  } catch (err) {
    console.error('[VoxFlow] Failed to restore reminders:', err.message || err);
  }
}

// ── Natural Language Date Parsing ────────────────────────────

/**
 * Parse a natural language date/time string into a Date object.
 * Handles: "in 5 minutes", "at 3pm", "tomorrow at 10am",
 *          "in 1 hour", "at 14:30", "2026-04-25 09:00", etc.
 * @param {string} input
 * @returns {Date|null}
 */
export function parseDateTime(input) {
  if (!input) return null;

  const now = new Date();
  const lower = input.toLowerCase().trim();

  // "in X minutes/hours/seconds"
  const relativeMatch = lower.match(/^in\s+(\d+)\s*(second|sec|minute|min|hour|hr|day)s?$/);
  if (relativeMatch) {
    const amount = parseInt(relativeMatch[1], 10);
    const unit = relativeMatch[2];
    const ms = {
      second: 1000, sec: 1000,
      minute: 60000, min: 60000,
      hour: 3600000, hr: 3600000,
      day: 86400000,
    }[unit] || 60000;
    return new Date(now.getTime() + amount * ms);
  }

  // "tomorrow at Xam/pm" or "tomorrow at HH:MM"
  const tomorrowMatch = lower.match(/^tomorrow\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (tomorrowMatch) {
    const d = new Date(now);
    d.setDate(d.getDate() + 1);
    let hours = parseInt(tomorrowMatch[1], 10);
    const minutes = parseInt(tomorrowMatch[2] || '0', 10);
    const ampm = tomorrowMatch[3];
    if (ampm === 'pm' && hours < 12) hours += 12;
    if (ampm === 'am' && hours === 12) hours = 0;
    d.setHours(hours, minutes, 0, 0);
    return d;
  }

  // "today at Xam/pm"
  const todayMatch = lower.match(/^today\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (todayMatch) {
    const d = new Date(now);
    let hours = parseInt(todayMatch[1], 10);
    const minutes = parseInt(todayMatch[2] || '0', 10);
    const ampm = todayMatch[3];
    if (ampm === 'pm' && hours < 12) hours += 12;
    if (ampm === 'am' && hours === 12) hours = 0;
    d.setHours(hours, minutes, 0, 0);
    return d;
  }

  // "at Xam/pm" or "at HH:MM"
  const atMatch = lower.match(/^(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/);
  if (atMatch) {
    const d = new Date(now);
    let hours = parseInt(atMatch[1], 10);
    const minutes = parseInt(atMatch[2] || '0', 10);
    const ampm = atMatch[3];
    if (ampm === 'pm' && hours < 12) hours += 12;
    if (ampm === 'am' && hours === 12) hours = 0;
    d.setHours(hours, minutes, 0, 0);
    // If time already passed today, set for tomorrow
    if (d <= now) d.setDate(d.getDate() + 1);
    return d;
  }

  // "at HH:MM" (24-hour)
  const at24Match = lower.match(/^(?:at\s+)?(\d{1,2}):(\d{2})$/);
  if (at24Match) {
    const d = new Date(now);
    const hours = parseInt(at24Match[1], 10);
    const minutes = parseInt(at24Match[2], 10);
    d.setHours(hours, minutes, 0, 0);
    if (d <= now) d.setDate(d.getDate() + 1);
    return d;
  }

  // ISO or standard date format: "2026-04-25 09:00" or "04/25/2026 3pm"
  const parsed = new Date(input);
  if (!isNaN(parsed.getTime()) && parsed > now) {
    return parsed;
  }

  // "X minutes" / "X hours" (without "in")
  const shortRelative = lower.match(/^(\d+)\s*(second|sec|minute|min|hour|hr|day)s?$/);
  if (shortRelative) {
    const amount = parseInt(shortRelative[1], 10);
    const unit = shortRelative[2];
    const ms = {
      second: 1000, sec: 1000,
      minute: 60000, min: 60000,
      hour: 3600000, hr: 3600000,
      day: 86400000,
    }[unit] || 60000;
    return new Date(now.getTime() + amount * ms);
  }

  return null;
}

// ── Reminder CRUD ────────────────────────────────────────────

/**
 * Create a new reminder.
 * @param {object} params
 * @param {string} params.what - What to remind about
 * @param {string} params.when - Natural language date/time
 * @param {string} params.sessionId - Session that created this
 * @returns {{ success: boolean, reminder?: object, error?: string }}
 */
export function createReminder({ what, title, when, sessionId }) {
  if (!what && !title) {
    return { success: false, error: 'Please tell me what to remind you about.' };
  }
  if (!when) {
    return { success: false, error: 'Please tell me when you\'d like to be reminded (e.g., "in 5 minutes", "at 3pm", "tomorrow at 10am").' };
  }

  const fireAt = parseDateTime(when);
  if (!fireAt) {
    return {
      success: false,
      error: `I couldn't understand the time "${when}". Try something like "in 5 minutes", "at 3pm", or "tomorrow at 10am".`,
    };
  }

  if (fireAt <= new Date()) {
    return { success: false, error: 'That time has already passed. Please provide a future date/time.' };
  }

  const id = `reminder-${nextId++}`;
  const reminder = {
    id,
    title: title || what,
    what: what || title,
    when: fireAt.toISOString(),
    whenHuman: formatFriendlyTime(fireAt),
    rawWhen: when,
    sessionId,
    createdAt: new Date().toISOString(),
    status: 'scheduled',
  };

  reminders.set(id, reminder);
  scheduleReminder(reminder);
  persistReminders();

  console.log(`[VoxFlow] 🔔 Reminder scheduled: "${what}" at ${reminder.whenHuman} (${id})`);

  return { success: true, reminder };
}

/**
 * Get all reminders for a session.
 */
export function getReminders(sessionId) {
  return [...reminders.values()]
    .filter(r => r.sessionId === sessionId)
    .sort((a, b) => new Date(a.when) - new Date(b.when));
}

/**
 * Cancel a reminder by ID.
 */
export function cancelReminder(reminderId) {
  const reminder = reminders.get(reminderId);
  if (!reminder) return null;

  // Clear the timer
  const timerId = timers.get(reminderId);
  if (timerId) {
    clearTimeout(timerId);
    timers.delete(reminderId);
  }

  reminder.status = 'cancelled';
  reminders.delete(reminderId);
  persistReminders();
  console.log(`[VoxFlow] ❌ Reminder cancelled: ${reminderId}`);
  return reminder;
}

// ── Scheduler ────────────────────────────────────────────────

/**
 * Schedule a timer for a reminder.
 */
function scheduleReminder(reminder) {
  const delay = new Date(reminder.when).getTime() - Date.now();

  if (delay <= 0) {
    fireReminder(reminder);
    return;
  }

  // setTimeout max is ~24.8 days (2^31 ms). For longer delays, chain.
  const maxDelay = 2147483647;
  const actualDelay = Math.min(delay, maxDelay);

  const timerId = setTimeout(() => {
    if (delay > maxDelay) {
      // Re-schedule for the remaining time
      scheduleReminder(reminder);
    } else {
      fireReminder(reminder);
    }
  }, actualDelay);

  timers.set(reminder.id, timerId);
}

/**
 * Fire a reminder — notify all SSE listeners.
 */
function fireReminder(reminder) {
  reminder.status = 'fired';
  reminders.delete(reminder.id);
  timers.delete(reminder.id);
  persistReminders();

  console.log(`[VoxFlow] 🔔🔔 REMINDER FIRED: "${reminder.what}"`);

  // Notify all connected SSE clients
  const event = {
    type: 'reminder',
    id: reminder.id,
    title: reminder.title,
    what: reminder.what,
    when: reminder.when,
    whenHuman: reminder.whenHuman,
    sessionId: reminder.sessionId,
    firedAt: new Date().toISOString(),
  };

  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
      listeners.delete(listener);
    }
  }
}

// ── SSE Listener Management ──────────────────────────────────

/**
 * Register an SSE listener for reminder events.
 * @param {function} callback - Called with reminder event when one fires
 * @returns {function} Unsubscribe function
 */
export function onReminderFired(callback) {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

// ── Utilities ────────────────────────────────────────────────

function formatFriendlyTime(date) {
  const now = new Date();
  const diffMs = date.getTime() - now.getTime();
  const diffMin = Math.round(diffMs / 60000);

  const timeStr = date.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });

  const isToday = date.toDateString() === now.toDateString();
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const isTomorrow = date.toDateString() === tomorrow.toDateString();

  if (isToday) {
    if (diffMin < 60) return `in ${diffMin} minute${diffMin !== 1 ? 's' : ''} (${timeStr})`;
    return `today at ${timeStr}`;
  }
  if (isTomorrow) return `tomorrow at ${timeStr}`;

  const dateStr = date.toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric',
  });
  return `${dateStr} at ${timeStr}`;
}

restoreReminders();

// Periodic check for due reminders (in case timers are missed due to restart or long delays)
setInterval(() => {
  const now = Date.now();
  for (const [id, reminder] of reminders) {
    if (reminder.status === 'scheduled' && new Date(reminder.when).getTime() <= now) {
      fireReminder(reminder);
    }
  }
}, 30000); // check every 30 seconds
