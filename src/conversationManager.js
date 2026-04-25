/**
 * VoxFlow — Conversation Manager
 * Multi-turn context tracking, API communication, and chat UI rendering.
 * Displays tool-usage badges, source citations, action confirmation cards,
 * and optional debug panel on assistant messages.
 */
import { parseAIResponse } from './actions/responseParser.js';
import { chunkActions } from './utils/chunker.js';
// const { chunkActions } = require('./utils/chunker');
// import { parseAIResponse } from "./actions/actionParser.js";
import { executeAction } from "./actions/actionExecutor.js";

const MAX_HISTORY = 20;

const TOOL_BADGES = {
  retrieval: { icon: '🔍', label: 'Retrieved', className: 'badge-retrieval' },
  api:       { icon: '⚡', label: 'Action',    className: 'badge-api' },
  reasoning: { icon: '🧠', label: 'Reasoning', className: 'badge-reasoning' },
};

const QUERY_TYPE_LABELS = {
  KNOWLEDGE: { icon: '📚', label: 'Knowledge' },
  ACTION:    { icon: '⚙️', label: 'Action' },
  GENERAL:   { icon: '💬', label: 'General' },
};

export class ConversationManager {
  constructor({ chatContainer, onStatusChange }) {
    this.chatContainer = chatContainer;
    this.onStatusChange = onStatusChange;
    this.history = [];
    this.isProcessing = false;
    this.debugMode = false;
    this.sessionId = `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  setDebugMode(enabled) {
    this.debugMode = enabled;
    document.querySelectorAll('.debug-panel').forEach(el => {
      el.classList.toggle('hidden', !enabled);
    });
  }

  async send(userText) {
    if (!userText.trim() || this.isProcessing) return null;

    this.isProcessing = true;
    this.onStatusChange?.('processing', 'Thinking...');

    this.history.push({ role: 'user', content: userText.trim() });
    this._renderMessage('user', userText.trim());

    const typingEl = this._showTypingIndicator();

    try {
      const response = await fetch('http://localhost:3002/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: userText.trim(),
          history: this.history.slice(-MAX_HISTORY),
          sessionId: this.sessionId,
          debug: this.debugMode,
        }),
      });

      if (!response.ok) throw new Error(`Server error: ${response.status}`);

      const data = await response.json();
      const reply = data.reply || "Sorry, I didn't quite catch that.";
      // STEP 1: Parse AI response
      const parsed = parseAIResponse(reply);

      // STEP 2: Chunk actions
      const actions = chunkActions(parsed);

      console.log("🧠 Parsed:", parsed);
      console.log("⚡ Actions:", actions);
      import { executeAction } from './actionExecutor';

      actions.forEach(action => {
        executeAction(action.payload);
      });
      typingEl.remove();

      const parsedResponse = parseAIResponse(reply);

      // 👇 THIS is where chunker comes
      const actions = chunkActions(parsedResponse);

      // Execute all actions
      for (const action of actions) {
        const result = await executeAction(action);
        console.log("Action Result:", result);
      }

      this.history.push({ role: 'assistant', content: reply });

      this._renderMessage('assistant', reply, {
        action: data.action,
        toolUsed: data.toolUsed,
        queryType: data.queryType,
        sources: data.sources,
        debug: data.debug,
      });

      this.isProcessing = false;
      this.onStatusChange?.('ready', 'Ready');

      return reply;

    } catch (err) {
      console.error('[VoxFlow] Chat error:', err);
      typingEl.remove();

      const errReply = "Hmm, I had trouble processing that. Can you try again?";
      this._renderMessage('assistant', errReply);

      this.isProcessing = false;
      this.onStatusChange?.('error', 'Error');
      setTimeout(() => this.onStatusChange?.('ready', 'Ready'), 3000);

      return errReply;
    }
  }

  
  /** Render a chat bubble */
  _renderMessage(role, text, meta = {}) {
    const msgEl = document.createElement('div');
    msgEl.className = `message ${role}-message`;

    if (role === 'assistant') {
      const badgeHtml = this._renderToolBadge(meta.toolUsed, meta.queryType);
      const sourcesHtml = this._renderSources(meta.sources);
      const actionHtml = meta.action ? this._renderActionCard(meta.action) : '';
      const debugHtml = this._renderDebugPanel(meta.debug);

      msgEl.innerHTML = `
        <div class="message-avatar">
          <svg viewBox="0 0 32 32" fill="none">
            <circle cx="16" cy="16" r="14" stroke="url(#avatarGrad)" stroke-width="2" fill="none"/>
            <circle cx="16" cy="16" r="4" fill="url(#avatarGrad)"/>
            <defs>
              <linearGradient id="avatarGrad" x1="0" y1="0" x2="32" y2="32">
                <stop offset="0%" stop-color="#6C63FF"/>
                <stop offset="100%" stop-color="#00D4AA"/>
              </linearGradient>
            </defs>
          </svg>
        </div>
        <div class="message-content">
          ${badgeHtml}
          <p>${this._escapeHtml(text)}</p>
          ${actionHtml}
          ${sourcesHtml}
          ${debugHtml}
        </div>
      `;

      // Bind action button handlers after inserting into DOM
      if (meta.action) {
        setTimeout(() => this._bindActionButtons(msgEl, meta.action), 0);
      }
    } else {
      msgEl.innerHTML = `
        <div class="message-content">
          <p>${this._escapeHtml(text)}</p>
        </div>
      `;
    }

    this.chatContainer.appendChild(msgEl);
    this._scrollToBottom();
  }

  /** Render tool-used badge with query type */
  _renderToolBadge(toolUsed, queryType) {
    let html = '';

    if (queryType && QUERY_TYPE_LABELS[queryType]) {
      const qt = QUERY_TYPE_LABELS[queryType];
      html += `<span class="query-type-badge">${qt.icon} ${qt.label}</span>`;
    }

    if (toolUsed && TOOL_BADGES[toolUsed]) {
      const badge = TOOL_BADGES[toolUsed];
      html += `<span class="tool-badge ${badge.className}">${badge.icon} ${badge.label}</span>`;
    }

    return html ? `<div class="badge-row">${html}</div>` : '';
  }

  /** Render source citations */
  _renderSources(sources) {
    if (!sources || sources.length === 0) return '';
    const items = sources
      .map(s => `<span class="source-tag">${this._escapeHtml(s)}</span>`)
      .join('');
    return `<div class="sources-row">Sources: ${items}</div>`;
  }

  /** Render action confirmation card with Confirm/Cancel buttons */
  _renderActionCard(action) {
    const statusIcon = action.status === 'confirmed' ? '✅'
      : action.status === 'cancelled' ? '❌'
      : action.status === 'awaiting_confirmation' ? '⏳'
      : '⚡';

    const detailsHtml = action.details
      ? this._renderActionDetails(action.details)
      : '';

    let optionsHtml = '';
    if (action.options && action.status === 'needs_disambiguation') {
      optionsHtml = `<div class="action-options-list" style="display: flex; flex-direction: column; gap: 8px; margin-top: 10px;">`;
      action.options.forEach((opt) => {
        optionsHtml += `<button class="action-btn select-option" style="text-align: left; background: rgba(255,255,255,0.05); padding: 8px; border: 1px solid rgba(255,255,255,0.1); border-radius: 6px; cursor: pointer;" data-action="select" data-action-id="${action.id}" data-option-email="${opt.email}" data-option-name="${opt.label}">Select: ${this._escapeHtml(opt.label)} &lt;${this._escapeHtml(opt.email)}&gt;</button>`;
      });
      optionsHtml += `</div>`;
    }

    const actionBtnsHtml = action.status === 'needs_disambiguation'
      ? `${optionsHtml}
         <div class="action-btns" data-action-id="${action.id}" style="margin-top: 12px; font-size: 0.9em; font-weight: bold; color: orange;">
           ↑ Click a recipient above to draft the email, then you can Approve it.
           <button class="action-btn cancel" data-action="cancel" data-action-id="${action.id}" style="margin-top: 8px;">✕ Cancel</button>
         </div>`
      : `<div class="action-btns" data-action-id="${action.id}">
          <button class="action-btn confirm" data-action="confirm" data-action-id="${action.id}">✓ Approve</button>
          ${action.intent === 'email' && (action.details.regenCount || 0) < 3 ? `<button class="action-btn regenerate" data-action="regenerate" data-action-id="${action.id}">🔄 Regenerate (${3 - (action.details.regenCount || 0)})</button>` : ''}
          <button class="action-btn cancel" data-action="cancel" data-action-id="${action.id}">✕ Cancel</button>
        </div>`;

    return `
      <div class="action-card" data-action-id="${action.id}">
        <div class="action-card-header">
          <div class="action-card-title">${action.icon || statusIcon} ${this._escapeHtml(action.type || 'Action')}</div>
          <div class="action-card-status-badge status-${action.status}">${statusIcon} ${this._formatStatus(action.status)}</div>
        </div>
        <div class="action-card-body">${this._escapeHtml(action.description || '')}</div>
        ${action.followUp && action.status === 'needs_disambiguation' ? `<div style="font-size: 0.9em; margin-bottom: 8px; opacity: 0.9;">${this._escapeHtml(action.followUp)}</div>` : ''}
        ${detailsHtml}
        ${actionBtnsHtml}
      </div>
    `;
  }

  /** Render extracted action details */
  _renderActionDetails(details) {
    const hiddenKeys = ['raw', 'options'];
    const entries = Object.entries(details)
      .filter(([k, v]) => !hiddenKeys.includes(k) && v)
      .map(([k, v]) => `<span class="detail-item" style="white-space: pre-wrap;"><strong>${k}:</strong> ${this._escapeHtml(v)}</span>`)
      .join('');

    return entries ? `<div class="action-details">${entries}</div>` : '';
  }

  /** Format action status for display */
  _formatStatus(status) {
    const labels = {
      awaiting_confirmation: 'Awaiting Confirmation',
      confirmed: 'Confirmed',
      cancelled: 'Cancelled',
      pending: 'Pending',
      needs_disambiguation: 'Needs Disambiguation',
    };
    return labels[status] || status;
  }

  /** Bind action buttons */
  _bindActionButtons(msgEl, action) {
    const confirmBtn = msgEl.querySelector(`.action-btn.confirm[data-action-id="${action.id}"]`);
    const cancelBtn = msgEl.querySelector(`.action-btn.cancel[data-action-id="${action.id}"]`);
    const selectBtns = msgEl.querySelectorAll(`button.select-option[data-action-id="${action.id}"]`);
    const regenBtn = msgEl.querySelector(`button.regenerate[data-action-id="${action.id}"]`);

    if (confirmBtn) {
      confirmBtn.addEventListener('click', () => this._handleActionConfirm(action.id, msgEl));
    }
    if (cancelBtn) {
      cancelBtn.addEventListener('click', () => this._handleActionCancel(action.id, msgEl));
    }
    selectBtns.forEach(btn => {
      btn.addEventListener('click', (e) => {
        const optionEmail = e.currentTarget.getAttribute('data-option-email');
        const optionName = e.currentTarget.getAttribute('data-option-name');
        this._handleActionSelect(action.id, optionEmail, optionName, msgEl);
      });
    });
    if (regenBtn) {
      regenBtn.addEventListener('click', () => this._handleRegenerate(action.id, msgEl));
    }
  }

  /** Handle action confirmation */
  async _handleActionConfirm(actionId, msgEl) {
    const card = msgEl.querySelector(`.action-card[data-action-id="${actionId}"]`);
    const btns = card?.querySelector('.action-btns');
    if (btns) btns.innerHTML = '<span class="action-loading">Processing...</span>';

    try {
      const resp = await fetch('/api/action/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ actionId, sessionId: this.sessionId }),
      });

      const data = await resp.json();

      if (resp.ok) {
        // Update the card UI
        this._updateActionCard(card, 'confirmed', data.result?.message || 'Action completed!');
      } else {
        this._updateActionCard(card, 'error', data.error || 'Failed to confirm.');
      }
    } catch (err) {
      console.error('[VoxFlow] Action confirm error:', err);
      this._updateActionCard(card, 'error', 'Network error. Please try again.');
    }
  }

  /** Handle action selection (disambiguation) */
  async _handleActionSelect(actionId, optionEmail, optionName, msgEl) {
    const card = msgEl.querySelector(`.action-card[data-action-id="${actionId}"]`);
    const optionsList = card?.querySelector('.action-options-list');
    if (optionsList) optionsList.innerHTML = '<span class="action-loading">Selecting...</span>';

    try {
      const resp = await fetch('/api/action/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ actionId, selectedEmail: optionEmail, selectedName: optionName, sessionId: this.sessionId }),
      });

      const data = await resp.json();

      if (resp.ok) {
        // We completely re-render the card body because details have updated.
        // It's simpler to just indicate success directly or add a message.
        // For VoxFlow, we can just replace the parent's message entirely, but here we just update UI.
        const parent = card.parentNode;
        parent.removeChild(card);
        // data.action has the updated action
        const newCardHtml = this._renderActionCard(data.action);
        parent.innerHTML = parent.innerHTML + newCardHtml;
        this._bindActionButtons(parent, data.action);
      } else {
         if (optionsList) optionsList.innerHTML = `<span class="action-result error">⚠️ ${this._escapeHtml(data.error || 'Failed to select.')}</span>`;
      }
    } catch (err) {
      console.error('[VoxFlow] Action select error:', err);
      if (optionsList) optionsList.innerHTML = '<span class="action-result error">⚠️ Network error. Please try again.</span>';
    }
  }

  /** Handle action cancellation */
  async _handleActionCancel(actionId, msgEl) {
    const card = msgEl.querySelector(`.action-card[data-action-id="${actionId}"]`);
    const btns = card?.querySelector('.action-btns');
    if (btns) btns.innerHTML = '<span class="action-loading">Cancelling...</span>';

    try {
      const resp = await fetch('/api/action/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ actionId, sessionId: this.sessionId }),
      });

      if (resp.ok) {
        this._updateActionCard(card, 'cancelled', 'Action was cancelled.');
      } else {
        const data = await resp.json();
        this._updateActionCard(card, 'error', data.error || 'Failed to cancel.');
      }
    } catch (err) {
      console.error('[VoxFlow] Action cancel error:', err);
      this._updateActionCard(card, 'error', 'Network error. Please try again.');
    }
  }

  /** Handle action regeneration */
  async _handleRegenerate(actionId, msgEl) {
    const card = msgEl.querySelector(`.action-card[data-action-id="${actionId}"]`);
    const btn = card?.querySelector('.regenerate');
    if (btn) {
      btn.disabled = true;
      btn.textContent = '🔄 Regenerating...';
    }

    try {
      const resp = await fetch('/api/action/regenerate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ actionId, sessionId: this.sessionId }),
      });
      const data = await resp.json();

      if (resp.ok) {
        // Find message-content wrapper
        const parent = card.parentNode;
        parent.removeChild(card);
        const newCardHtml = this._renderActionCard(data.action);
        parent.innerHTML = parent.innerHTML + newCardHtml;
        this._bindActionButtons(parent, data.action);
      } else {
        if (btn) {
          btn.disabled = false;
          btn.textContent = '⚠️ Failed to regenerate';
        }
      }
    } catch (err) {
      console.error('[VoxFlow] Action regenerate failed:', err);
      if (btn) {
        btn.disabled = false;
        btn.textContent = '⚠️ Network error';
      }
    }
  }

  /** Update action card after confirm/cancel */
  _updateActionCard(card, status, resultMessage) {
    if (!card) return;

    const statusBadge = card.querySelector('.action-card-status-badge');
    const btnsArea = card.querySelector('.action-btns');

    if (status === 'confirmed') {
      card.classList.add('confirmed');
      if (statusBadge) {
        statusBadge.textContent = '✅ Confirmed';
        statusBadge.className = 'action-card-status-badge status-confirmed';
      }
      if (btnsArea) {
        btnsArea.innerHTML = `<div class="action-result success">✅ ${this._escapeHtml(resultMessage)}</div>`;
      }
    } else if (status === 'cancelled') {
      card.classList.add('cancelled');
      if (statusBadge) {
        statusBadge.textContent = '❌ Cancelled';
        statusBadge.className = 'action-card-status-badge status-cancelled';
      }
      if (btnsArea) {
        btnsArea.innerHTML = `<div class="action-result cancelled">❌ ${this._escapeHtml(resultMessage)}</div>`;
      }
    } else {
      if (btnsArea) {
        btnsArea.innerHTML = `<div class="action-result error">⚠️ ${this._escapeHtml(resultMessage)}</div>`;
      }
    }
  }

  /** Render debug panel (hidden by default, toggled via header switch) */
  _renderDebugPanel(debug) {
    if (!debug) return '';

    const hiddenClass = this.debugMode ? '' : 'hidden';

    return `
      <div class="debug-panel ${hiddenClass}">
        <div class="debug-title">🔍 Pipeline Trace</div>
        <div class="debug-grid">
          <div class="debug-item">
            <span class="debug-label">Query Type</span>
            <span class="debug-value">${debug.queryType || '—'}</span>
          </div>
          <div class="debug-item">
            <span class="debug-label">Intent</span>
            <span class="debug-value">${debug.intent || '—'}</span>
          </div>
          <div class="debug-item">
            <span class="debug-label">Tool</span>
            <span class="debug-value">${debug.toolUsed || '—'}</span>
          </div>
          <div class="debug-item">
            <span class="debug-label">Latency</span>
            <span class="debug-value">${debug.latencyMs || 0}ms</span>
          </div>
          <div class="debug-item">
            <span class="debug-label">Sources</span>
            <span class="debug-value">${debug.sourcesCount || 0}</span>
          </div>
          <div class="debug-item">
            <span class="debug-label">Follow-up</span>
            <span class="debug-value">${debug.isFollowUp ? 'Yes' : 'No'}</span>
          </div>
          <div class="debug-item">
            <span class="debug-label">Turn</span>
            <span class="debug-value">#${debug.turnCount || 0}</span>
          </div>
          <div class="debug-item">
            <span class="debug-label">Action</span>
            <span class="debug-value">${debug.actionTaken || '—'}</span>
          </div>
        </div>
        ${debug.contextUsed && debug.contextUsed !== '(none)'
          ? `<div class="debug-context">
               <span class="debug-label">Context</span>
               <div class="debug-context-text">${this._escapeHtml(debug.contextUsed)}</div>
             </div>`
          : ''}
      </div>
    `;
  }

  /** Show typing dots */
  _showTypingIndicator() {
    const el = document.createElement('div');
    el.className = 'message assistant-message';
    el.id = 'typingIndicator';
    el.innerHTML = `
      <div class="message-avatar">
        <svg viewBox="0 0 32 32" fill="none">
          <circle cx="16" cy="16" r="14" stroke="url(#avatarGrad)" stroke-width="2" fill="none"/>
          <circle cx="16" cy="16" r="4" fill="url(#avatarGrad)"/>
        </svg>
      </div>
      <div class="message-content">
        <div class="typing-indicator">
          <span class="dot"></span>
          <span class="dot"></span>
          <span class="dot"></span>
        </div>
      </div>
    `;
    this.chatContainer.appendChild(el);
    this._scrollToBottom();
    return el;
  }

  _scrollToBottom() {
    const area = this.chatContainer.closest('#chatArea');
    if (area) {
      requestAnimationFrame(() => {
        area.scrollTop = area.scrollHeight;
      });
    }
  }

  _escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }
}
