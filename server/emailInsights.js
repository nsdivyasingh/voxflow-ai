import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';

function getEmailConfig() {
  const host = (process.env.EMAIL_IMAP_HOST || '').trim();
  const user = (process.env.EMAIL_ADDRESS || process.env.SMTP_USER || '').trim();
  const passRaw = (process.env.EMAIL_APP_PASSWORD || process.env.SMTP_PASS || '').trim();
  const pass = passRaw.replace(/^['"]|['"]$/g, '');

  return {
    host,
    port: Number(process.env.EMAIL_IMAP_PORT || 993),
    secure: String(process.env.EMAIL_IMAP_SECURE || 'true') === 'true',
    user,
    pass,
    mailbox: process.env.EMAIL_IMAP_MAILBOX || 'INBOX',
    openRouterApiKey: process.env.OPENROUTER_API_KEY || '',
    openRouterModel: process.env.OPENROUTER_MODEL || 'google/gemma-3-27b-it:free',
  };
}

function validateEmailConfig(config) {
  if (!config.host || !config.user || !config.pass) {
    return {
      ok: false,
      error:
        'Missing email IMAP config. Set EMAIL_IMAP_HOST, EMAIL_ADDRESS, EMAIL_APP_PASSWORD (and optionally EMAIL_IMAP_PORT/EMAIL_IMAP_SECURE).',
    };
  }
  return { ok: true };
}

function streamToBuffer(stream) {
  if (!stream) return Promise.resolve(Buffer.alloc(0));
  if (Buffer.isBuffer(stream)) return Promise.resolve(stream);
  if (stream instanceof Uint8Array) return Promise.resolve(Buffer.from(stream));
  if (typeof stream === 'string') return Promise.resolve(Buffer.from(stream, 'utf8'));
  if (typeof stream.on !== 'function') {
    return Promise.resolve(Buffer.from(String(stream), 'utf8'));
  }

  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.once('end', () => resolve(Buffer.concat(chunks)));
    stream.once('error', reject);
  });
}

function normalizeAddressList(addresses = []) {
  return addresses
    .map((entry) => {
      if (!entry || !entry.address) return null;
      return {
        name: entry.name || '',
        address: entry.address.toLowerCase(),
      };
    })
    .filter(Boolean);
}

function summarizeText(text, maxLength = 1500) {
  if (!text) return '';
  return text.replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function isParticipantMatch(message, emailAddress) {
  const target = emailAddress.toLowerCase();
  const allParticipants = [...(message.from || []), ...(message.to || []), ...(message.cc || [])];
  return allParticipants.some((p) => p.address === target);
}

async function fetchEmailsInternal({ days = 7, limit = 25 }) {
  const cfg = getEmailConfig();
  const valid = validateEmailConfig(cfg);
  if (!valid.ok) {
    throw new Error(valid.error);
  }

  const client = new ImapFlow({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: {
      user: cfg.user,
      pass: cfg.pass,
    },
  });

  const sinceDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const messages = [];

  try {
    await client.connect();
    await client.mailboxOpen(cfg.mailbox);

    const uids = await client.search({ since: sinceDate });
    const targetUids = uids.slice(-Math.max(1, limit)).reverse();

    for await (const msg of client.fetch(targetUids, { envelope: true, source: true, internalDate: true })) {
      const parsed = await simpleParser(await streamToBuffer(msg.source));
      const from = normalizeAddressList(parsed.from?.value || msg.envelope?.from || []);
      const to = normalizeAddressList(parsed.to?.value || msg.envelope?.to || []);
      const cc = normalizeAddressList(parsed.cc?.value || msg.envelope?.cc || []);

      messages.push({
        uid: msg.uid,
        subject: parsed.subject || msg.envelope?.subject || '(No subject)',
        date: (parsed.date || msg.internalDate || new Date()).toISOString(),
        from,
        to,
        cc,
        textSnippet: summarizeText(parsed.text || parsed.html || ''),
      });
    }

    return messages.sort((a, b) => new Date(b.date) - new Date(a.date));
  } finally {
    await client.logout().catch(() => {});
  }
}

async function summarizeWithOpenRouter({ personEmail, days, messages }) {
  const cfg = getEmailConfig();
  if (!cfg.openRouterApiKey) {
    throw new Error('OPENROUTER_API_KEY is not set. Cannot generate analysis summary.');
  }

  const compact = messages.map((m, idx) => ({
    id: idx + 1,
    date: m.date,
    subject: m.subject,
    from: m.from.map((x) => x.address).join(', '),
    to: m.to.map((x) => x.address).join(', '),
    cc: m.cc.map((x) => x.address).join(', '),
    snippet: m.textSnippet.slice(0, 700),
  }));

  const prompt = `You are an email analysis assistant.
Analyze the email conversation with ${personEmail} from the last ${days} days.
Return JSON only with this exact schema:
{
  "summary": "1 short paragraph",
  "discussionTopics": ["topic 1", "topic 2"],
  "deliverablesCompleted": ["item 1", "item 2"],
  "pendingDeliverables": ["item 1", "item 2"],
  "decisions": ["decision 1", "decision 2"],
  "actionItems": ["owner - action - due(if any)"],
  "risksOrBlockers": ["risk 1", "risk 2"]
}
Rules:
- Use only the provided email data.
- If uncertain, mention it conservatively.
- Keep lists concise and presentation-ready.

Email data:
${JSON.stringify(compact, null, 2)}`;

  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cfg.openRouterApiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'http://localhost:3000',
      'X-Title': 'VoxFlow',
    },
    body: JSON.stringify({
      model: cfg.openRouterModel,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.2,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenRouter request failed (${response.status}): ${body}`);
  }

  const payload = await response.json();
  const content = payload?.choices?.[0]?.message?.content || '';
  const jsonText = content.replace(/```json\s*/gi, '').replace(/```/g, '').trim();

  try {
    return JSON.parse(jsonText);
  } catch {
    return {
      summary: content || 'Summary generation failed to return structured JSON.',
      discussionTopics: [],
      deliverablesCompleted: [],
      pendingDeliverables: [],
      decisions: [],
      actionItems: [],
      risksOrBlockers: [],
    };
  }
}

export async function getRecentEmails({ days = 7, limit = 25 }) {
  const messages = await fetchEmailsInternal({ days, limit });
  return {
    days,
    count: messages.length,
    messages,
  };
}

export async function analyzeEmailsForPerson({ personEmail, days = 30, limit = 120 }) {
  if (!personEmail || typeof personEmail !== 'string') {
    throw new Error('personEmail is required.');
  }

  const all = await fetchEmailsInternal({ days, limit });
  const filtered = all.filter((message) => isParticipantMatch(message, personEmail));

  if (filtered.length === 0) {
    return {
      personEmail,
      days,
      messageCount: 0,
      analysis: {
        summary: `No emails found with ${personEmail} in the last ${days} days.`,
        discussionTopics: [],
        deliverablesCompleted: [],
        pendingDeliverables: [],
        decisions: [],
        actionItems: [],
        risksOrBlockers: [],
      },
      messages: [],
    };
  }

  const analysis = await summarizeWithOpenRouter({
    personEmail,
    days,
    messages: filtered,
  });

  return {
    personEmail,
    days,
    messageCount: filtered.length,
    analysis,
    messages: filtered,
  };
}

/**
 * Sync recent emails for offline access or caching.
 * @param {number} days
 * @param {number} limit
 */
export async function syncEmails({ days = 7, limit = 50 }) {
  const emails = await fetchEmailsInternal({ days, limit });
  // For now, just return; in future, store in local DB or memory
  console.log(`[VoxFlow] Synced ${emails.length} emails`);
  return emails;
}

