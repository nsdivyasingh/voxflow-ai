/**
 * VoxFlow — Action Executor
 * Prepares, validates, and manages action execution.
 * Actions are NEVER executed without explicit user confirmation.
 *
 * Reminders are REAL — they schedule a local timer and fire
 * browser notifications via SSE when the time comes.
 */

import { createReminder, getReminders, cancelReminder } from './reminderStore.js';
import nodemailer from 'nodemailer';

let groqClient = null;
let llmInitialized = false;

async function ensureLLM() {
  if (llmInitialized) return;

  const provider = process.env.LLM_PROVIDER || 'gemini';

  if (provider === 'gemini' && process.env.GEMINI_API_KEY) {
    try {
      const { GoogleGenerativeAI } = await import('@google/generative-ai');
      const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
      groqClient = {
        model: genAI.getGenerativeModel({ model: 'gemini-2.0-flash' }),
        isGemini: true
      };
      console.log('[VoxFlow] ✅ Gemini LLM initialized for Actions');
    } catch (err) {
      console.warn('[VoxFlow] Failed to load Gemini for actions', err);
    }
  } else if (process.env.OPENROUTER_API_KEY) {
    try {
      const { default: Groq } = await import('groq-sdk');
      groqClient = new Groq({
        apiKey: process.env.OPENROUTER_API_KEY,
        baseURL: "https://openrouter.ai/api/v1",
        defaultHeaders: { "HTTP-Referer": "http://localhost:3000", "X-Title": "VoxFlow" }
      });
      groqClient.isOpenRouter = true;
      console.log('[VoxFlow] ✅ OpenRouter LLM initialized for Actions');
    } catch (err) {
      console.warn('[VoxFlow] Failed to load OpenRouter for actions', err);
    }
  } else if (process.env.GROQ_API_KEY) {
    try {
      const { default: Groq } = await import('groq-sdk');
      groqClient = new Groq({ apiKey: process.env.GROQ_API_KEY });
      console.log('[VoxFlow] ✅ Groq LLM initialized for Actions');
    } catch (err) {
      console.warn('[VoxFlow] Failed to load Groq for actions', err);
    }
  }

  llmInitialized = true;
}

// ── Dummy Database ───────────────────────────────────────────
const EMPLOYEE_DB = [
  { name: 'Madhumitha', email: 'madhumithats1708@gmail.com', phone: '', keywords: ['madhumitha', 'shashi', 'madhumita', 'madhu', 'mehta', 'name-1'] },
  { name: 'Trisha', email: 'trishats2906@gmail.com', phone: '', keywords: ['trisha', 'name-2'] },
  { name: 'Dr. Sujith', email: 'dr.sujith@example.com', phone: '', keywords: ['dr. sujith', 'sujith', 'dr sujith', 'sujit'] },
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
    followUp: "Got it! I'll set that reminder for you. Can you confirm the details?",
    confirmMessage: "Your reminder has been set!",
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
  whatsapp: {
    type: 'WhatsApp',
    icon: '💬',
    description: 'Sending a WhatsApp message',
    requiredFields: ['recipient', 'content'],
    followUp: "I've drafted your WhatsApp message. Please confirm to send it.",
    confirmMessage: "Your WhatsApp message is ready to be sent!",
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

  let followUp = template.followUp;
  if (intent === 'reminder') {
    if (details.what && details.when) {
      followUp = `Got it! I'll remind you to "${details.what}" at ${details.when}. Please confirm to set this reminder.`;
    } else if (details.what && !details.when) {
      followUp = `I'll remind you to "${details.what}". When should I remind you? (e.g., "in 5 minutes", "at 3pm", "tomorrow at 10am")`;
    } else {
      followUp = `Sure, I can set a reminder! What should I remind you about, and when? (e.g., "Remind me to check email at 3pm")`;
    }
  }

  const action = {
    type: template.type,
    icon: template.icon,
    description: template.description,
    status: 'awaiting_confirmation',
    followUp,
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
      // Try to extract "remind me to X at/on/in Y"
      const reminderMatch = message.match(/remind(?:\s+me)?\s+(?:to\s+)?(.+?)\s+(?:at|on|in|by|after)\s+(.+)$/i);
      if (reminderMatch) {
        details.what = reminderMatch[1]?.trim();
        details.when = reminderMatch[2]?.trim();
      } else {
        const titleMatch = message.match(/title\s+(?:is\s+|of\s+)?["']?([^"']+)["']?/i);
        if (titleMatch) {
          details.title = titleMatch[1]?.trim();
        }

        // Try "remind me to X" (no time)
        const whatOnly = message.match(/remind(?:\s+me)?\s+(?:to\s+)?(.+)$/i);
        if (whatOnly) {
          details.what = whatOnly[1]?.trim();
        }
        // Try to find a time anywhere: "at 3pm", "in 5 min", "tomorrow"
        const timeMatch = message.match(/(?:at\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)|in\s+\d+\s*(?:min|minute|hour|hr|second|sec|day)s?|tomorrow(?:\s+at\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?)?)/i);
        if (timeMatch) {
          details.when = timeMatch[0]?.trim();
          // Remove the time part from "what" if it was captured there
          if (details.what) {
            details.what = details.what.replace(timeMatch[0], '').trim();
          }
        }
        if (!details.what && details.title) {
          details.what = details.title;
        }
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
    case 'whatsapp':
    case 'email': {
      if (groqClient) {
        try {
          const isEmail = intent === 'email';
          const formatRequirement = isEmail 
            ? "CRITICAL: The email body MUST be at least 2 detailed, relatable paragraphs accurately expanding on the user's prompt. Ensure the tone is professional and polite."
            : "CRITICAL: The WhatsApp message should be concise, friendly, and formatted suitably for a chat application.";
            
          const draftTemplate = isEmail
            ? `"draft": "Dear [Name],\\n\\n[Paragraph 1...]\\n\\n[Paragraph 2...]\\n\\nBest regards,\\nNagesh Kore"`
            : `"draft": "Hey [Name], [Friendly WhatsApp message...] - Nagesh"`;

          const prompt = `
You are an expert executive assistant drafting a ${isEmail ? 'professional email' : 'WhatsApp message'}.
User input: "${message}"

Extract the intended recipient (this could be a name or an email/phone). 
Then, construct a highly professional, well-formatted message based on the user's instructions.
${formatRequirement}

Output ONLY a JSON block like:
{
  "recipient": "Extracted Name or Address",
  "subject": "Subject (if email)",
  "draft": ${draftTemplate}
}
Do not return markdown ticks. Just the JSON.`;

          let rawResponse = '';
          if (groqClient.isGemini) {
            const result = await groqClient.model.generateContent(prompt);
            rawResponse = result.response.text();
          } else if (groqClient.isOpenRouter) {
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
                messages: [{ role: "user", content: prompt }],
                temperature: 0.5
              })
            });
            if (!response.ok) {
              throw new Error(`OpenRouter API error: ${response.status} ${await response.text()}`);
            }
            const data = await response.json();
            rawResponse = data.choices[0].message.content;
          } else {
            const chatCompletion = await groqClient.chat.completions.create({
              messages: [{ role: 'user', content: prompt }],
              model: 'llama-3.3-70b-versatile',
              temperature: 0.5,
            });
            rawResponse = chatCompletion.choices[0].message.content;
          }

          const jsonMatch = rawResponse.match(/\{[\s\S]*\}/);
          if (!jsonMatch) throw new Error("No JSON object found in LLM response");
          const parsed = JSON.parse(jsonMatch[0]);

          details.intended_recipient = parsed.recipient;
          details.subject = parsed.subject;
          details.content = parsed.draft;

          // Resolve recipient
          const isEmailFormat = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(parsed.recipient);
          const isPhoneFormat = /^\d+$/.test(parsed.recipient);
          
          if (intent === 'email') {
            if (isEmailFormat) {
              details.recipient_email = parsed.recipient;
              details.recipient_name = parsed.recipient.split('@')[0];
            } else {
              const matches = findEmployeesByName(parsed.recipient);
              if (matches.length > 1) {
                details.options = matches.map(m => ({ label: m.name, email: m.email }));
              } else if (matches.length === 1) {
                details.recipient_email = matches[0].email;
                details.recipient_name = matches[0].name;
              } else {
                details.recipient_email = 'unknown@example.com';
                details.recipient_name = parsed.recipient;
              }
            }
          } else if (intent === 'whatsapp') {
            if (isPhoneFormat) {
              details.recipient_phone = parsed.recipient;
              details.recipient_name = parsed.recipient;
            } else {
              const matches = findEmployeesByName(parsed.recipient);
              if (matches.length > 0) {
                details.recipient_phone = matches[0].phone || 'Unknown';
                details.recipient_name = matches[0].name;
              } else {
                details.recipient_phone = 'Unknown';
                details.recipient_name = parsed.recipient;
              }
            }
          }
        } catch (err) {
          console.error('[VoxFlow] LLM extraction failed, falling back to regex:', err.message || err);
          
          if (intent === 'email') {
            const emailMatch = message.match(/(?:(?:send )?(?:an? )?(?:e?mail) to|email)\s+([^\s]+)(?:\s+(?:about|regarding|saying|with|that)\s+(.+))?/i);
            if (emailMatch) {
              details.intended_recipient = emailMatch[1]?.trim();
              const rawContent = emailMatch[2]?.trim() || "important updates";
              const paragraph1 = `I hope this email finds you well. I am writing to you today regarding ${rawContent}. I wanted to ensure that you have all the necessary information and that we are fully aligned on this matter.`;
              const paragraph2 = `Please let me know if you have any questions or require further clarification. I look forward to your prompt response and to discussing this further if needed.`;
              details.content = `Dear ${details.intended_recipient},\n\n${paragraph1}\n\n${paragraph2}\n\nBest regards,\nNagesh Kore`;
              const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(details.intended_recipient);
              if (isEmail) {
                details.recipient_email = details.intended_recipient;
                details.recipient_name = details.intended_recipient.split('@')[0];
              } else {
                const matches = findEmployeesByName(details.intended_recipient);
                if (matches.length > 0) {
                  details.recipient_email = matches[0].email;
                  details.recipient_name = matches[0].name;
                } else {
                  details.recipient_email = 'unknown@example.com';
                  details.recipient_name = details.intended_recipient;
                }
              }
            } else {
              details.recipient = 'Unknown';
              details.content = 'Failed to generate draft. Please specify the recipient and content clearly.';
            }
          } else if (intent === 'whatsapp') {
            const waMatch = message.match(/(?:whatsapp|message|msg).*?(?:search|to|for|contact)\s+([a-zA-Z0-9.\s]+?)(?:\s+(?:saying|with|that|send a message|message|say|and send a message)\s+(.+))?$/i) 
                            || message.match(/(?:whatsapp|message|msg)\s+(?:to\s+)?([^\s]+)(?:\s+(?:saying|with|that)\s+(.+))?/i);
            
            let foundMatch = null;
            let potentialName = waMatch ? waMatch[1]?.trim() : null;
            let rawMsg = waMatch ? waMatch[2]?.trim() : message.replace(/whatsapp|message|msg/ig, '').trim();

            if (potentialName) {
              const exactMatches = findEmployeesByName(potentialName);
              if (exactMatches.length > 0) foundMatch = exactMatches[0];
            }

            if (!foundMatch) {
              // Search every word in the message to find an employee
              const words = message.split(/[\s,]+/);
              for (const word of words) {
                if (word.length < 3) continue;
                const matches = findEmployeesByName(word);
                if (matches.length > 0) {
                  foundMatch = matches[0];
                  potentialName = word;
                  break;
                }
              }
            }

            if (foundMatch) {
              details.intended_recipient = potentialName;
              details.recipient_phone = foundMatch.phone || '';
              details.recipient_name = foundMatch.name;
              details.content = `Hey ${foundMatch.name},\n\n${rawMsg || "I wanted to reach out to you."}\n\n- Nagesh`;
            } else if (potentialName) {
              details.intended_recipient = potentialName;
              details.recipient_phone = /^\d+$/.test(potentialName) ? potentialName : '';
              details.recipient_name = potentialName;
              details.content = `Hey ${potentialName},\n\n${rawMsg || "I wanted to reach out to you."}\n\n- Nagesh`;
            } else {
              details.intended_recipient = "Unknown";
              details.recipient_phone = '';
              details.recipient_name = "Unknown";
              details.content = "Failed to parse WhatsApp details. Please specify the name and message clearly.";
            }
          }
        }
      } else {
        // No LLM initialized at all fallback
        if (intent === 'email') {
          const emailMatch = message.match(/(?:(?:send )?(?:an? )?(?:e?mail) to|email)\s+([^\s]+)(?:\s+(?:about|regarding|saying|with|that)\s+(.+))?/i);
          if (emailMatch) {
            details.intended_recipient = emailMatch[1]?.trim();
            const rawContent = emailMatch[2]?.trim() || "important updates";
            details.content = `Dear ${details.intended_recipient},\n\nI hope this email finds you well. I am writing to you today regarding ${rawContent}.\n\nBest regards,\nNagesh Kore`;
            const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(details.intended_recipient);
            if (isEmail) {
              details.recipient_email = details.intended_recipient;
              details.recipient_name = details.intended_recipient.split('@')[0];
            } else {
              const matches = findEmployeesByName(details.intended_recipient);
              if (matches.length > 0) {
                details.recipient_email = matches[0].email;
                details.recipient_name = matches[0].name;
              } else {
                details.recipient_email = 'unknown@example.com';
                details.recipient_name = details.intended_recipient;
              }
            }
          }
        } else if (intent === 'whatsapp') {
          const waMatch = message.match(/(?:whatsapp|message|msg).*?(?:search|to|for|contact)\s+([a-zA-Z0-9.\s]+?)(?:\s+(?:saying|with|that|send a message|message|say|and send a message)\s+(.+))?$/i) 
                          || message.match(/(?:whatsapp|message|msg)\s+(?:to\s+)?([^\s]+)(?:\s+(?:saying|with|that)\s+(.+))?/i);
          
          let foundMatch = null;
          let potentialName = waMatch ? waMatch[1]?.trim() : null;
          let rawMsg = waMatch ? waMatch[2]?.trim() : message.replace(/whatsapp|message|msg/ig, '').trim();

          if (potentialName) {
            const exactMatches = findEmployeesByName(potentialName);
            if (exactMatches.length > 0) foundMatch = exactMatches[0];
          }

          if (!foundMatch) {
            const words = message.split(/[\s,]+/);
            for (const word of words) {
              if (word.length < 3) continue;
              const matches = findEmployeesByName(word);
              if (matches.length > 0) {
                foundMatch = matches[0];
                potentialName = word;
                break;
              }
            }
          }

          if (foundMatch) {
            details.intended_recipient = potentialName;
            details.recipient_phone = foundMatch.phone || '';
            details.recipient_name = foundMatch.name;
            details.content = `Hey ${foundMatch.name},\n\n${rawMsg || "I wanted to reach out to you."}\n\n- Nagesh`;
          } else if (potentialName) {
            details.intended_recipient = potentialName;
            details.recipient_phone = /^\d+$/.test(potentialName) ? potentialName : '';
            details.recipient_name = potentialName;
            details.content = `Hey ${potentialName},\n\n${rawMsg || "I wanted to reach out to you."}\n\n- Nagesh`;
          } else {
            details.intended_recipient = "Unknown";
            details.recipient_phone = '';
            details.recipient_name = "Unknown";
            details.content = "Failed to parse WhatsApp details. Please specify the name and message clearly.";
          }
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
  "draft": "Dear [Name],\\n\\n[Body]\\n\\nBest regards,\\nNagesh Kore"
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
 * @param {string} sessionId - The session ID for ownership
 * @returns {Promise<{ success: boolean, message: string, reminder?: any, executedAt?: number }>}
 */
export async function executeConfirmedAction(action, sessionId) {
  const template = ACTION_TEMPLATES[action.intent];
  console.log(`[VoxFlow] ⚡ Executing action: ${action.type}`, action.details);

  let confirmMsg = template?.confirmMessage || `${action.type} completed successfully!`;

  if (action.intent === 'email') {
    const to = action.details.recipient_email;
    const body = action.details.content;
    const subject = action.details.subject || 'Automated Email via VoxFlow';

    // To send emails from nagesh.amcec@gmail.com, SMTP_PASS must be exactly the app password provided via env.
    const smtpUser = process.env.SMTP_USER || 'nagesh.amcec@gmail.com';

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
          from: `"Nagesh Kore" <${smtpUser}>`,
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

  if (action.intent === 'whatsapp') {
    const toName = action.details.recipient_name || action.details.intended_recipient;
    const phone = action.details.recipient_phone || '';
    const msg = encodeURIComponent(action.details.content);
    const waLink = `https://wa.me/${phone}?text=${msg}`;
    
    console.log(`[VoxFlow] 💬 Simulated WhatsApp to ${toName} (${phone || 'Unmapped'})`);
    console.log(`--- WhatsApp Content ---\n${action.details.content}\n---------------------`);
    console.log(`[VoxFlow] 🔗 WhatsApp Link: ${waLink}`);
    
    return {
      success: true,
      message: `WhatsApp message prepared for ${toName}!`,
      url: waLink,
      executedAt: Date.now(),
    };
  }

  if (action.intent === 'reminder') {
    const result = createReminder({
      what: action.details?.what || action.details?.title || 'Reminder',
      title: action.details?.title,
      when: action.details?.when || '',
      sessionId: sessionId || 'default',
    });

    if (!result.success) {
      return {
        success: false,
        message: result.error || 'Failed to set reminder.',
      };
    }

    return {
      success: true,
      message: `🔔 Reminder set! I'll notify you ${result.reminder.whenHuman} — "${result.reminder.what}"`,
      reminder: result.reminder,
      executedAt: Date.now(),
    };
  }

  // Other actions: simulated (would call real APIs in production)
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