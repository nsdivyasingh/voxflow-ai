# VoxFlow

VoxFlow is a voice-first AI assistant web app with a multi-stage orchestrator, retrieval-backed answers, action confirmation workflows, and conversation memory.

It combines:
- a Vite frontend (typed + voice chat),
- an Express backend (intent, routing, actions, memory),
- an optional Python FastAPI retrieval service,
- and Qdrant for vector-based knowledge and long-term memory.

## Core capabilities

- Voice and text conversation in a single chat experience.
- Intent-aware orchestration with query classes: `KNOWLEDGE`, `ACTION`, `GENERAL`.
- Retrieval pipeline with graceful fallback:
  1. Python retrieval API (`/ask`) when available,
  2. direct Qdrant search from Node,
  3. in-memory fallback knowledge base.
- Action flow with explicit user confirmation before execution (reminders, email, schedule, notes, WhatsApp).
- Mail intelligence: fetch recent inbox emails and generate person-wise discussion/deliverable summaries.
- 3-tier memory system:
  - short-term turn buffer,
  - long-term summarized memory in Qdrant,
  - extracted user entities/preferences in Qdrant.
- Reminder scheduler with Server-Sent Events (SSE) for real-time browser notifications.
- Persistent reminder storage and restore on backend restart (`server/reminders.json` runtime file).
- Workspace-style UI with 3 columns: left control sidebar, center chat, right live reminders/calendar panel.
- Optional debug trace to inspect orchestrator decisions in chat.

## Architecture overview

### Request flow (`/api/chat`)

1. Record user turn in memory.
2. Detect intent (`server/intentDetector.js`).
3. Classify query type (`KNOWLEDGE` / `ACTION` / `GENERAL`).
4. Recall memory context (if enabled and relevant).
5. Route:
   - `KNOWLEDGE` -> retrieval path,
   - `ACTION` -> prepare action card (no execution yet),
   - `GENERAL` -> direct response generation.
6. Generate response (LLM when configured, fallback templates otherwise).
7. Return SSE stream (`metadata`, `chunk`, `done`) to frontend.
8. Post-response memory updates (assistant turn, summarization cadence, entity extraction).

## Tech stack

| Layer | Stack |
|---|---|
| Frontend | Vite, Vanilla JS, CSS |
| Backend | Node.js, Express, CORS, dotenv |
| Retrieval (Node) | `@qdrant/js-client-rest`, Gemini embeddings |
| Retrieval (Python) | FastAPI, Uvicorn, `qdrant-client`, requests |
| LLM | Gemini (`@google/generative-ai`), optional OpenRouter/Groq |
| Voice | `@vapi-ai/web`, browser SpeechRecognition + SpeechSynthesis |
| Email action | Nodemailer (SMTP) |

## Project structure

```text
voxflow-ai/
  src/                    Frontend app (UI, voice, chat manager)
    actions/              Client-side action parsing/execution helpers
    utils/
  server/                 Express API + orchestrator + tools
    orchestrator.js       Core decision pipeline
    retriever.js          Retrieval orchestration and fallbacks
    memoryLayer.js        Short/long/entity memory logic
    actionExecutor.js     Action preparation and confirmed execution
    reminderStore.js      Reminder scheduler + SSE event emitter
    calendarSync.js       Google Calendar integration (optional)
  qdrant/                 Python FastAPI retrieval service
    main.py               /ask endpoint
    qdrant_service.py     Qdrant query helpers
  public/                 Static assets
  requiremnets.txt        Python dependencies (filename kept as-is)
  README.md
```

## Prerequisites

- Node.js 18+
- Python 3.10+
- Qdrant instance (cloud or self-hosted) for full retrieval + memory features
- API keys depending on selected providers

## Environment variables

This repository currently includes a `.env` file locally. For team-safe setup, create your own `.env` from the template below and do not commit secrets.

```env
# Core provider selection
LLM_PROVIDER=gemini

# LLM keys
GEMINI_API_KEY=
OPENAI_API_KEY=
OPENROUTER_API_KEY=
GROQ_API_KEY=

# Voice (optional Vapi)
VAPI_PUBLIC_KEY=
VAPI_ASSISTANT_ID=

# Qdrant / retrieval
QDRANT_URL=
QDRANT_API_KEY=
QDRANT_COLLECTION=voxflow-kb
PYTHON_QDRANT_URL=http://127.0.0.1:8001

# Debug
DEBUG_MODE=false

# Email action (optional)
SMTP_USER=
SMTP_PASS=

# Inbox reading and analysis (IMAP)
EMAIL_IMAP_HOST=
EMAIL_IMAP_PORT=993
EMAIL_IMAP_SECURE=true
EMAIL_IMAP_MAILBOX=INBOX
EMAIL_ADDRESS=
EMAIL_APP_PASSWORD=

# OpenRouter model for email analysis
OPENROUTER_MODEL=google/gemma-3-27b-it:free

# Google Calendar sync (optional)
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REFRESH_TOKEN=
```

### Variable notes

- `GEMINI_API_KEY` is used for response generation, embeddings, and memory extraction when Gemini is active.
- `OPENROUTER_API_KEY` / `GROQ_API_KEY` enable alternate generation routes.
- `QDRANT_URL` + `QDRANT_API_KEY` are required for direct vector retrieval and persistent memory collections.
- `PYTHON_QDRANT_URL` enables Python `/ask` retrieval route (default `http://127.0.0.1:8001`).
- `VAPI_*` controls whether frontend uses Vapi voice vs browser Web Speech fallback.
- `SMTP_*` enables real email sending on approved email actions.
- `EMAIL_IMAP_*` + `EMAIL_ADDRESS` + `EMAIL_APP_PASSWORD` enable inbox fetch and analysis endpoints.
- `OPENROUTER_MODEL` controls which OpenRouter model summarizes email threads.
- `GOOGLE_CLIENT_*` + `GOOGLE_REFRESH_TOKEN` enable calendar add/list endpoints.

## Local development

Install JavaScript dependencies:

```bash
npm install
```

Install Python dependencies:

```bash
pip install -r requiremnets.txt
```

Run all services:

```bash
npm run dev
```

### What `npm run dev` starts

| Service | Port | Purpose |
|---|---|---|
| Vite frontend | `5173` | UI + `/api` proxy to backend |
| Express backend | `3001` | Orchestrator API |
| FastAPI retrieval | `8001` | Python `/ask` retrieval endpoint |

Open [http://localhost:5173](http://localhost:5173).

### Script reference

| Script | Description |
|---|---|
| `npm run dev` | Clean ports and start frontend + backend + python |
| `npm run dev:clean` | Kill ports `3001`, `5173`, `5174`, `8001` |
| `npm run dev:frontend` | Start Vite |
| `npm run dev:backend` | Start Express with nodemon |
| `npm run dev:python` | Start FastAPI via local `.venv` Python |
| `npm run build` | Build frontend to `dist/` |
| `npm run preview` | Preview production build |

Note: `dev:python` currently uses a Windows path to `.venv` Python in `package.json`.

## API reference

Base URL (dev backend): `http://localhost:3001`

### Chat and config

- `POST /api/chat`
  - Body: `{ message, history?, sessionId?, debug? }`
  - Returns SSE stream with:
    - `event: metadata`,
    - `event: chunk`,
    - `event: done`.
- `GET /api/config`
  - Returns public frontend config (for example, whether Vapi is enabled).

### Actions

- `POST /api/action/confirm`
- `POST /api/action/cancel`

Actions are prepared first and executed only after confirmation.

### Reminders and memory

- `GET /api/reminders/events` (SSE stream for fired reminders)
- `GET /api/reminders?sessionId=...`
- `POST /api/reminders/:id/cancel`
- `DELETE /api/memory/:sessionId`

### Calendar

- `POST /api/calendar/add`
  - Body: `{ summary, startTime, endTime, description? }`
  - Adds an event to Google Calendar (when calendar credentials are configured).
- `GET /api/calendar/upcoming`
  - Returns `{ events: [...] }` for upcoming events.

### Health

- `GET /api/health`
- `GET /api/health/retrieval`
- `GET /api/health/memory`

### Email insights

- `GET /api/email/recent?days=7&limit=25`
  - Fetches latest inbox emails from the given window.
- `GET /api/email/person-summary?email=person@example.com&days=30&limit=120`
  - Filters threads involving a person and generates OpenRouter summary:
    - discussion topics
    - completed deliverables
    - pending deliverables
    - decisions
    - action items
    - blockers/risks
- `POST /api/email/sync`
  - Body: `{ days?, limit? }`
  - Triggers inbox sync job and returns synced count.

### Python retrieval service

- `GET http://127.0.0.1:8001/ask?q=<query>`

## Retrieval behavior

Current retrieval strategy in `server/retriever.js`:

1. Try Python backend first (`PYTHON_QDRANT_URL`).
2. If unavailable, try direct Qdrant from Node (Gemini embedding + Qdrant search).
3. If still unavailable, use in-memory keyword-scored fallback entries.

Use `GET /api/health/retrieval` to inspect active path and last errors.

## Memory system details

Implemented in `server/memoryLayer.js`:

- **Short-term memory**: in-process rolling buffer per session.
- **Long-term memory**: periodic conversation summaries embedded and stored in `voxflow-memory`.
- **Entity memory**: extracted personal facts/preferences stored in `voxflow-entities`.
- **Recall**: semantic lookup across summaries and entities, injected into response generation.

If Qdrant or Gemini keys are missing, memory features degrade gracefully.

## Voice behavior

- If `VAPI_PUBLIC_KEY` + `VAPI_ASSISTANT_ID` are set, frontend uses Vapi call mode.
- Otherwise it falls back to browser Web Speech APIs.
- Typed queries still receive TTS output (when available).
- Reminder events can trigger browser notifications and spoken reminders.

## UI behavior (current)

- Left sidebar shows status and quick actions.
- Center panel handles conversation and confirmation cards.
- Right panel shows active reminders and upcoming calendar events.
- Composer stays visible at bottom of chat column without covering messages/cards.

## Optional: seed Qdrant knowledge

```bash
node server/seedQdrant.js
```

Requires: `QDRANT_URL`, `QDRANT_API_KEY`, `GEMINI_API_KEY`.

## Build and deploy notes

Build frontend:

```bash
npm run build
```

Deploy `dist/` on a static host, and run backend services separately:
- Express API (`server/index.js`)
- optional Python retrieval service (`qdrant/main.py`)
- configured env vars for LLM, Qdrant, voice, and email actions

## Troubleshooting

- `GET /api/health` fails: confirm backend is running on `3001`.
- Empty/weak knowledge responses: check `GET /api/health/retrieval` and Python service reachability.
- Memory not used: verify Qdrant + Gemini env vars and `GET /api/health/memory`.
- No voice input: browser may not support SpeechRecognition, or microphone permission is denied.
- Vapi not active: verify `VAPI_PUBLIC_KEY` and `VAPI_ASSISTANT_ID`.
- Email confirmation succeeds but mail not sent: verify `SMTP_USER`/`SMTP_PASS` and provider app-password settings.

## Security checklist

- Never commit `.env` files with real keys.
- Rotate any API keys exposed in local history or screenshots.
- Keep production keys in a secret manager (not in source control).

## License

Private project. Contact repository owner for usage terms.
