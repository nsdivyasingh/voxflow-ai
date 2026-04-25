/**
 * VoxFlow — Action Executor
 * Prepares, validates, and manages action execution.
 * Actions are NEVER executed without explicit user confirmation.
 */

import nodemailer from 'nodemailer';

let groqClient = null;
let llmInitialized = false;

async function ensureLLM() {
  if (llmInitialized) return;
  
  if (process.env.GROQ_API_KEY) {
    try {
      const { default: Groq } = await import('groq-sdk');
      groqClient = new Groq({ apiKey: process.env.GROQ_API_KEY });
    } catch (err) {
      console.warn('[VoxFlow] Failed to load Groq for actions', err);
    }
  } else if (process.env.GEMINI_API_KEY) {
    try {
      const { GoogleGenerativeAI } = await import('@google/generative-ai');
      const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
      groqClient = {
        model: genAI.getGenerativeModel({ model: 'gemini-2.0-flash' }),
        isGemini: true
      };
    } catch (err) {
      console.warn('[VoxFlow] Failed to load Gemini for actions', err);
    }
  }
  llmInitialized = true;
}

// ── Dummy Database ───────────────────────────────────────────
const EMPLOYEE_DB = [
  { name: 'Madhumitha', email: 'madhumithats1708@gmail.com', keywords: ['madhumitha', 'shashi', 'madhumita', 'madhu', 'mehta'] },
  { name: 'Trisha', email: 'trishats2906@gmail.com', keywords: ['trisha'] },
];

function findEmployeesByName(nameQuery) {
  if (!nameQuery) return [];
  const q = nameQuery.toLowerCase();
  return EMPLOYEE_DB.filter(emp => emp.keywords.some(k => q.includes(k) || k.includes(q)));
}

// ── Action Templates ─────────────────────────────────────────
const ACTION_TEMPLATES = {
  reminder: {
    type: 'Reminder',
    icon: '🔔',
    description: 'Setting a new reminder',
    requiredFields: ['what', 'when'],
    followUp: "Got it! I'll set that reminder for you. Can you confirm what I should remind you about and when?",
    confirmMessage: "Your reminder has been set successfully!",
  },
  schedule: {
    type: 'Calendar Event',
    icon: '📅',
    description: 'Creating a calendar event',
    requiredFields: ['event', 'date', 'time'],
    followUp: "I'll help you schedule that. What's the event name, date, and time?",
    confirmMessage: "Your event has been added to the calendar!",
  },
  email: {
    type: 'Email',
    icon: '✉️',
    description: 'Composing an email',
    requiredFields: ['recipient', 'content'],
    followUp: "Sure, I've drafted that email for you. Please review it before sending.",
    confirmMessage: "Your email has been sent!",
  },
  note: {
    type: 'Note',
    icon: '📝',
    description: 'Creating a note',
    requiredFields: ['content'],
    followUp: "I'll save that for you. What would you like the note to say?",
    confirmMessage: "Your note has been saved!",
  },
};

/**
 * Prepare an action descriptor for a given intent.
 * Does NOT execute — only builds the action for user confirmation.
 * @param {string} intent
 * @param {string} message
 * @returns {Promise<{ type, icon, description, status, followUp, details, options? } | null>}
 */
export async function prepareAction(intent, message) {
  const template = ACTION_TEMPLATES[intent];
  if (!template) return null;

  // Extract details (async for LLM calls)
  const details = await extractActionDetails(intent, message);

  const action = {
    type: template.type,
    icon: template.icon,
    description: template.description,
    status: 'awaiting_confirmation',
    followUp: template.followUp,
    confirmMessage: template.confirmMessage,
    details,
    intent,
  };

  // Special logic for email to handle disambiguation
  if (intent === 'email' && details.options) {
    action.status = 'needs_disambiguation';
    action.followUp = `I found multiple matching contacts for "${details.intended_recipient || 'that name'}". Please select the correct one.`;
    action.options = details.options;
  }

  return action;
}

/**
 * Extract action-relevant details from the user message.
 */
async function extractActionDetails(intent, message) {
  await ensureLLM();
  let details = { raw: message };

  switch (intent) {
    case 'reminder': {
      const reminderMatch = message.match(/remind(?:\s+me)?\s+(?:to\s+)?(.+?)(?:\s+(?:at|on|in|by)\s+(.+))?$/i);
      if (reminderMatch) {
        details.what = reminderMatch[1]?.trim();
        details.when = reminderMatch[2]?.trim();
      }
      break;
    }
    case 'schedule': {
      const schedMatch = message.match(/(?:schedule|book|create)\s+(?:a\s+)?(.+?)(?:\s+(?:on|for)\s+(.+?))?(?:\s+at\s+(.+))?$/i);
      if (schedMatch) {
        details.event = schedMatch[1]?.trim();
        details.date = schedMatch[2]?.trim();
        details.time = schedMatch[3]?.trim();
      }
      break;
    }
    case 'note': {
      const noteMatch = message.match(/(?:note|note down|save|remember)\s+(?:that\s+)?(.+)/i);
      if (noteMatch) {
        details.content = noteMatch[1]?.trim();
      }
      break;
    }
    case 'email': {
      if (groqClient) {
        try {
          const prompt = `
You are extracting information to draft an email.
User input: "${message}"

Extract the intended recipient name, and construct a professional, well-formatted email based on the intent (e.g. leave application, status update, sharing info, etc.).
Ensure it's highly professional.

Output ONLY a JSON block like:
{
  "recipient": "Extracted Name",
  "subject": "Professional Subject",
  "draft": "Dear [Name],\\n\\n[Body]\\n\\nBest regards,\\nDivya Singh"
}
Do not return markdown ticks. Just the JSON.`;
          
          let rawResponse = '';
          if (groqClient.isGemini) {
            const result = await groqClient.model.generateContent(prompt);
            rawResponse = result.response.text();
          } else {
            const chatCompletion = await groqClient.chat.completions.create({
              messages: [{ role: 'user', content: prompt }],
              model: 'llama-3.3-70b-versatile',
              temperature: 0.2,
            });
            rawResponse = chatCompletion.choices[0].message.content;
          }
          
          rawResponse = rawResponse.trim().replace(/^`{3}(json)?|`{3}$/g, '');
          const parsed = JSON.parse(rawResponse);
          
          details.intended_recipient = parsed.recipient;
          details.subject = parsed.subject;
          details.content = parsed.draft;

          // Resolve recipient
          const matches = findEmployeesByName(parsed.recipient);
          if (matches.length > 1) {
            details.options = matches.map(m => ({ label: m.name, email: m.email }));
          } else if (matches.length === 1) {
            details.recipient_email = matches[0].email;
            details.recipient_name = matches[0].name;
          } else {
            // fallback if no match found
            details.recipient_email = 'unknown@example.com';
            details.recipient_name = parsed.recipient;
          }
        } catch (err) {
          console.error('[VoxFlow] LLM extraction failed for email:', err);
          details.recipient = 'Unknown';
          details.content = 'Failed to generate draft.';
        }
      } else {
        const emailMatch = message.match(/(?:email|send.*mail.*to)\s+(.+?)(?:\s+(?:about|saying|with)\s+(.+))?$/i);
        if (emailMatch) {
          details.intended_recipient = emailMatch[1]?.trim();
          details.content = emailMatch[2]?.trim();
        }
      }
      break;
    }
  }

  return details;
}

export async function regenerateEmailDraft(message) {
  await ensureLLM();
  if (!groqClient) return null;

  try {
    const prompt = `
You are extracting information to draft an email.
User input: "${message}"

Please generate a different wording and format for the email than you did previously. Make it robust and professional.

Output ONLY a JSON block like:
{
  "recipient": "Extracted Name",
  "subject": "Professional Subject",
  "draft": "Dear [Name],\\n\\n[Body]\\n\\nBest regards,\\nDivya Singh"
}
Do not return markdown ticks. Just the JSON.`;

    let rawResponse = '';
    if (groqClient.isGemini) {
      const result = await groqClient.model.generateContent({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.8 }
      });
      rawResponse = result.response.text();
    } else {
      const chatCompletion = await groqClient.chat.completions.create({
        messages: [{ role: 'user', content: prompt }],
        model: 'llama-3.3-70b-versatile',
        temperature: 0.8,
      });
      rawResponse = chatCompletion.choices[0].message.content;
    }

    rawResponse = rawResponse.trim().replace(/^`{3}(json)?|`{3}$/g, '');
    const parsed = JSON.parse(rawResponse);
    return parsed;
  } catch (err) {
    console.error('[VoxFlow] Failed to regenerate draft', err);
    return null;
  }
}

/**
 * Execute a confirmed action.
 * @param {object} action - The confirmed action object
 * @returns {Promise<{ success: boolean, message: string }>}
 */
export async function executeConfirmedAction(action) {
  const template = ACTION_TEMPLATES[action.intent];
  console.log(`[VoxFlow] ⚡ Executing action: ${action.type}`, action.details);

  let confirmMsg = template?.confirmMessage || `${action.type} completed successfully!`;

  if (action.intent === 'email') {
    const to = action.details.recipient_email;
    const body = action.details.content;
    const subject = action.details.subject || 'Automated Email via VoxFlow';

    // To send emails from smadhumitha1708@gmail.com, SMTP_PASS must be exactly the app password provided via env.
    const smtpUser = 'smadhumitha1708@gmail.com'; 

    if (process.env.SMTP_PASS) {
      try {
        const password = process.env.SMTP_PASS.replace(/\s+/g, '').replace(/['"]/g, '');
        const transporter = nodemailer.createTransport({
          service: 'gmail',
          auth: {
            user: smtpUser,
            pass: password,
          },
        });
        await transporter.sendMail({
          from: `"Divya Singh" <${smtpUser}>`,
          to,
          subject,
          text: body,
        });
        console.log(`[VoxFlow] ✅ Real email sent to ${to} from ${smtpUser}`);
      } catch (err) {
        console.error('[VoxFlow] Email send failed:', err);
        confirmMsg = "Failed to send email. Check credentials.";
      }
    } else {
      console.log(`[VoxFlow] ⚠️ SMTP_PASS not set. Simulating email sent to ${to} from ${smtpUser}`);
      console.log(`--- Email Content ---\nSubject: ${subject}\n\n${body}\n---------------------`);
    }
  }

  return {
    success: true,
    message: confirmMsg,
    executedAt: Date.now(),
  };
}

/**
 * Get available action types (useful for debug/health).
 */
export function getAvailableActions() {
  return Object.entries(ACTION_TEMPLATES).map(([key, val]) => ({
    intent: key,
    type: val.type,
    icon: val.icon,
  }));
}
export function executeAction(action) {
  switch (action.type) {

    case "REMINDER":
      setReminder(action);
      break;

    case "EMAIL":
      console.log("📧 Email:", action);
      break;

    default:
      console.log("❌ Unknown action:", action);
  }
}
function setReminder(action) {
  const reminderTime = new Date(action.time).getTime();
  const now = Date.now();

  const delay = reminderTime - now;

  if (delay <= 0) {
    console.log("⚠️ Time already passed");
    return;
  }

  console.log(`⏰ Reminder set for ${action.message} at ${action.time}`);

  setTimeout(() => {
    console.log(`🔔 REMINDER: ${action.message}`);
  }, delay);
}