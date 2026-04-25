/**
 * VoxFlow — Main Application Bootstrap
 * Wires up UI elements, initializes voice engines (Vapi or browser fallback),
 * and handles the conversation flow.
 */

import './style.css';
import { SpeechRecognizer } from './speechRecognition.js';
import { SpeechSynth } from './speechSynthesis.js';
import { ConversationManager } from './conversationManager.js';
import { VapiVoice } from './vapiVoice.js';

// ── DOM References ──
const micBtn = document.getElementById('micBtn');
const micIcon = micBtn.querySelector('.mic-icon');
const micStopIcon = micBtn.querySelector('.mic-stop-icon');
const textInput = document.getElementById('textInput');
const sendBtn = document.getElementById('sendBtn');
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const liveTranscript = document.getElementById('liveTranscript');
const transcriptText = document.getElementById('transcriptText');
const chatMessages = document.getElementById('chatMessages');
const debugToggle = document.getElementById('debugToggle');

// ── Status Helper ──
function setStatus(state, text) {
  statusDot.className = 'status-dot';
  if (state !== 'ready') statusDot.classList.add(state);
  statusText.textContent = text;
}

// ── Conversation Manager ──
const conversation = new ConversationManager({
  chatContainer: chatMessages,
  onStatusChange: setStatus,
});

// ── Voice Engine ──
// We initialize asynchronously — fetch config from server to decide Vapi vs browser
let voiceEngine = null; // 'vapi' | 'browser' | null
let vapiVoice = null;
let recognizer = null;
let lastVapiFinalTranscript = '';
let lastVapiFinalAt = 0;

// Universally initialize TTS so written queries always get vocal feedback
let tts = new SpeechSynth({
  rate: 1.05,
  onStart: () => {
    if (!vapiVoice?.isInCall) setStatus('processing', 'Speaking');
  },
  onEnd: () => {
    if (!vapiVoice?.isInCall) setStatus('ready', 'Ready');
  },
});

async function initVoice() {
  try {
    // Fetch Vapi config from server
    const resp = await fetch('/api/config');
    const config = await resp.json();

    if (config.vapi?.enabled) {
      // ── Use Vapi for voice ──
      console.log('[VoxFlow] 🎙️ Initializing Vapi voice...');

      vapiVoice = new VapiVoice({
        publicKey: config.vapi.publicKey,
        assistantId: config.vapi.assistantId,

        onCallStart: () => {
          micBtn.classList.add('listening');
          micIcon.classList.add('hidden');
          micStopIcon.classList.remove('hidden');
          liveTranscript.classList.remove('hidden');
          transcriptText.textContent = 'Connected — speak now...';
          setStatus('listening', 'Vapi Connected');
        },

        onCallEnd: () => {
          stopListeningUI();
          setStatus('ready', 'Ready');
        },

        onTranscript: (data) => {
          if (data.role === 'user') {
            transcriptText.textContent = data.text;
            if (data.isFinal) {
              void handleVapiFinalTranscript(data.text);
            }
          }
        },

        onSpeechStart: () => {
          setStatus('processing', 'Speaking');
        },

        onSpeechEnd: () => {
          if (vapiVoice?.isInCall) {
            setStatus('listening', 'Listening');
          }
        },

        onError: (err) => {
          console.error('[VoxFlow] Vapi error:', err);
          stopListeningUI();
          setStatus('error', 'Voice Error');
          setTimeout(() => setStatus('ready', 'Ready'), 3000);
        },
      });

      if (vapiVoice.isReady()) {
        voiceEngine = 'vapi';
        console.log('[VoxFlow] ✅ Vapi voice ready');
      } else {
        console.warn('[VoxFlow] Vapi init failed, falling back to browser');
        initBrowserVoice();
      }
    } else {
      // ── Use browser Web Speech API ──
      initBrowserVoice();
    }
  } catch (err) {
    console.warn('[VoxFlow] Config fetch failed, using browser voice:', err);
    initBrowserVoice();
  }
}

async function handleVapiFinalTranscript(text) {
  const cleaned = (text || '').trim();
  if (!cleaned) return;

  // Avoid duplicate sends from repeated final transcript events.
  const now = Date.now();
  if (cleaned === lastVapiFinalTranscript && now - lastVapiFinalAt < 1500) {
    return;
  }
  lastVapiFinalTranscript = cleaned;
  lastVapiFinalAt = now;

  const reply = await conversation.send(cleaned);
  if (!reply) return;

  // Keep voice-first behavior for Vapi calls while also rendering text in chat.
  if (vapiVoice?.isInCall) {
    vapiVoice.say(reply);
    return;
  }

  // Fallback speaking path if call ended before response arrives.
  if (tts) {
    tts.speak(reply);
  }
}

function initBrowserVoice() {
  voiceEngine = 'browser';
  console.log('[VoxFlow] 🔊 Using browser Web Speech API');

  // Speech Recognition
  if (SpeechRecognizer.isSupported()) {
    recognizer = new SpeechRecognizer({
      onStart: () => {
        micBtn.classList.add('listening');
        micIcon.classList.add('hidden');
        micStopIcon.classList.remove('hidden');
        liveTranscript.classList.remove('hidden');
        transcriptText.textContent = 'Listening...';
        setStatus('listening', 'Listening');
        tts.cancel();
      },
      onInterim: (text) => {
        transcriptText.textContent = text;
      },
      onResult: async (text) => {
        transcriptText.textContent = text;
        setTimeout(async () => {
          stopListeningUI();
          const reply = await conversation.send(text);
          if (reply) tts.speak(reply);
        }, 300);
      },
      onEnd: () => {
        stopListeningUI();
      },
      onError: (err) => {
        stopListeningUI();
        if (err === 'not-allowed') {
          setStatus('error', 'Mic denied');
        }
      },
    });
  } else {
    micBtn.style.opacity = '0.4';
    micBtn.style.cursor = 'not-allowed';
    micBtn.title = 'Speech recognition not supported in this browser';
  }
}

function stopListeningUI() {
  micBtn.classList.remove('listening');
  micIcon.classList.remove('hidden');
  micStopIcon.classList.add('hidden');
  liveTranscript.classList.add('hidden');
}

// ── Event Listeners ──

// Mic button — toggles Vapi call or browser recognition
micBtn.addEventListener('click', async () => {
  if (voiceEngine === 'vapi' && vapiVoice) {
    await vapiVoice.toggle();
  } else if (voiceEngine === 'browser' && recognizer) {
    recognizer.toggle();
  }
});

// Text input — send on Enter
textInput.addEventListener('keydown', async (e) => {
  if (e.key === 'Enter' && textInput.value.trim()) {
    e.preventDefault();
    await sendTextMessage();
  }
});

// Send button
sendBtn.addEventListener('click', async () => {
  if (textInput.value.trim()) {
    await sendTextMessage();
  }
});

// Highlight send button when input has text
textInput.addEventListener('input', () => {
  sendBtn.classList.toggle('active', textInput.value.trim().length > 0);
});

// Quick action buttons
document.addEventListener('click', async (e) => {
  if (e.target.matches('.quick-action-btn')) {
    const query = e.target.dataset.query;
    if (query) {
      textInput.value = '';
      const reply = await conversation.send(query);
      if (reply && tts && (!vapiVoice || !vapiVoice.isInCall)) {
        tts.speak(reply);
      }
    }
  }
});

async function sendTextMessage() {
  const text = textInput.value.trim();
  textInput.value = '';
  sendBtn.classList.remove('active');
  const reply = await conversation.send(text);
  // Use browser TTS for typed messages (if not actively in a Vapi call)
  if (reply && tts && (!vapiVoice || !vapiVoice.isInCall)) {
    tts.speak(reply);
  }
}

// Debug toggle
debugToggle.addEventListener('click', () => {
  debugToggle.classList.toggle('active');
  const isActive = debugToggle.classList.contains('active');
  conversation.setDebugMode(isActive);
});

// Clear Memory button
const clearMemoryBtn = document.getElementById('clearMemoryBtn');
clearMemoryBtn.addEventListener('click', async () => {
  const confirmed = confirm('Clear all conversation memory? This cannot be undone.');
  if (!confirmed) return;

  clearMemoryBtn.disabled = true;
  clearMemoryBtn.classList.add('clearing');
  const btnText = clearMemoryBtn.querySelector('span');
  const originalText = btnText.textContent;
  btnText.textContent = 'Clearing...';

  const success = await conversation.clearMemory();

  btnText.textContent = success ? 'Cleared!' : 'Failed';
  setTimeout(() => {
    btnText.textContent = originalText;
    clearMemoryBtn.disabled = false;
    clearMemoryBtn.classList.remove('clearing');
  }, 2000);
});

// ── Reminder Notifications ──

/**
 * Connect to the server's SSE stream for real-time reminder alerts.
 * When a reminder fires, show a browser notification + in-chat message.
 */
function initReminderListener() {
  // Request notification permission
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission().then(perm => {
      console.log('[VoxFlow] Notification permission:', perm);
    });
  }

  // Connect to SSE stream
  const evtSource = new EventSource('/api/reminders/events');

  evtSource.addEventListener('reminder', (e) => {
    try {
      const data = JSON.parse(e.data);
      console.log('[VoxFlow] 🔔 Reminder fired:', data);

      // Show browser notification
      if ('Notification' in window && Notification.permission === 'granted') {
        const notif = new Notification('🔔 VoxFlow Reminder', {
          body: data.what,
          icon: '/logo.jpeg',
          tag: data.id,
          requireInteraction: true,
        });
        notif.onclick = () => {
          window.focus();
          notif.close();
        };
      }

      // Show in-chat notification
      conversation._renderMessage('assistant', `🔔 **Reminder:** ${data.what}`, {
        toolUsed: 'api',
        queryType: 'ACTION',
        sources: ['Reminder System'],
      });

      // Speak the reminder aloud
      if (tts) {
        tts.speak(`Reminder: ${data.what}`);
      }
    } catch (err) {
      console.error('[VoxFlow] Reminder parse error:', err);
    }
  });

  evtSource.onerror = () => {
    console.warn('[VoxFlow] Reminder SSE connection lost, will reconnect...');
  };
}

// ── Initialization ──
setStatus('ready', 'Ready');
initVoice();
initReminderListener();
console.log('[VoxFlow] Application initialized.');
