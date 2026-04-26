/**
 * VoxFlow — Conversation Manager
 * Multi-turn context tracking, API communication, and chat UI rendering.
 * Displays tool-usage badges, source citations, action confirmation cards,
 * and optional debug panel on assistant messages.
 */

const MAX_HISTORY = 20;

const TOOL_BADGES = {
  retrieval: { icon: '🔍', label: 'Retrieved', className: 'badge-retrieval' },
  api:       { icon: '⚡', label: 'Action',    className: 'badge-api' },
  reasoning: { icon: '🧠', label: 'Reasoning', className: 'badge-reasoning' },
  memory:    { icon: '💾', label: 'Memory',    className: 'badge-memory' },
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

    // Persistent sessionId — survives page reloads via localStorage
    let storedId = null;
    try {
      storedId = localStorage.getItem('voxflow-session-id');
    } catch {}
    if (storedId) {
      this.sessionId = storedId;
    } else {
      this.sessionId = `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      try {
        localStorage.setItem('voxflow-session-id', this.sessionId);
      } catch {}
    }
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
      const response = await fetch('/api/chat', {
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


      const contentType = response.headers.get('content-type');
      if (contentType && contentType.includes('text/event-stream')) {
        typingEl.remove();
        const reader = response.body.getReader();
        const decoder = new TextDecoder('utf-8');
        
        let metadata = {};
        let replyText = '';
        let msgEl = null;
        let textNode = null;
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          
          buffer += decoder.decode(value, { stream: true });
          const parts = buffer.split('\n\n');
          buffer = parts.pop(); // Keep the last incomplete part in the buffer
          
          for (const part of parts) {
            const lines = part.split('\n');
            let eventType = null;
            let eventData = null;
            
            for (const line of lines) {
              if (line.startsWith('event: ')) {
                eventType = line.substring(7);
              } else if (line.startsWith('data: ')) {
                try {
                  eventData = JSON.parse(line.substring(6));
                } catch(e) {}
              }
            }
            
            if (eventType === 'metadata' && eventData) {
              metadata = eventData;
              msgEl = this._renderMessage('assistant', '', {
                action: metadata.action,
                toolUsed: metadata.toolUsed,
                queryType: metadata.queryType,
                sources: metadata.sources,
                debug: metadata.debug,
              });
              textNode = msgEl.querySelector('.chat-text');
            } else if (eventType === 'chunk' && eventData && eventData.text) {
              replyText += eventData.text;
              if (textNode) {
                textNode.innerHTML = this._escapeHtml(replyText);
              }
              this._scrollToBottom();
            } else if (eventType === 'done') {
              // stream finished
            } else if (eventType === 'error') {
              throw new Error('Stream error');
            }
          }
        }
        
        this.history.push({ role: 'assistant', content: replyText });
        this.isProcessing = false;
        this.onStatusChange?.('ready', 'Ready');

        // Update memory indicator if memory was used
        if (metadata.memoryUsed && msgEl) {
          this._addMemoryIndicator(msgEl, metadata.memoryCount);
        }


        return replyText;
      } else {
        const data = await response.json();
        const reply = data.reply || "Sorry, I didn't quite catch that.";


        typingEl.remove();
        this.history.push({ role: 'assistant', content: reply });
        const msgEl = this._renderMessage('assistant', reply, {
          action: data.action,
          toolUsed: data.toolUsed,
          queryType: data.queryType,
          sources: data.sources,
          debug: data.debug,
          memoryUsed: data.memoryUsed,
          memoryCount: data.memoryCount,
        });

        if (data.memoryUsed && msgEl) {
          this._addMemoryIndicator(msgEl, data.memoryCount);
        }

        this.isProcessing = false;
        this.onStatusChange?.('ready', 'Ready');
        return reply;
      }

    } catch (err) {
      console.error('[VoxFlow] Chat error:', err);
      typingEl.remove();

      const errReply = "Hmm, I had trouble processing that. Can you try again?";
      this._renderMessage('assistant', errReply);
      return errReply;
    } finally {
      this.isProcessing = false;
      this.onStatusChange?.('ready', 'Ready');
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
      const reminderHtml = meta.isReminder ? this._renderReminderButtons(meta.reminderId) : '';
      const debugHtml = this._renderDebugPanel(meta.debug);

      msgEl.innerHTML = `
        <div class="message-avatar">
          <img src="/logo.jpeg" alt="VoxFlow" class="avatar-logo" />
        </div>
        <div class="message-content">
          ${badgeHtml}
          <p class="chat-text">${this._escapeHtml(text)}</p>
          ${actionHtml}
          ${reminderHtml}
          ${sourcesHtml}
          ${debugHtml}
        </div>
      `;

      if (meta.action) {
        setTimeout(() => this._bindActionButtons(msgEl, meta.action), 0);
      }
      if (meta.isReminder) {
        setTimeout(() => this._bindReminderButtons(msgEl, meta.reminderId), 0);
      }
    } else {
      msgEl.innerHTML = `
        <div class="message-content">
          <p class="chat-text">${this._escapeHtml(text)}</p>
        </div>
      `;
    }

    this.chatContainer.appendChild(msgEl);
    this._scrollToBottom();
    return msgEl;
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

  /** Add a memory indicator to a message element */
  _addMemoryIndicator(msgEl, count) {
    const content = msgEl.querySelector('.message-content');
    if (!content) return;
    const indicator = document.createElement('div');
    indicator.className = 'memory-indicator';
    indicator.innerHTML = `<span class="memory-indicator-icon">🧠</span> <span class="memory-indicator-text">Used ${count} memor${count === 1 ? 'y' : 'ies'} from past conversations</span>`;
    content.appendChild(indicator);
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

  /** Render reminder buttons */
  _renderReminderButtons(reminderId) {
    return `
      <div class="reminder-btns" data-reminder-id="${reminderId}">
        <button class="reminder-btn stop-alarm" data-action="stop" data-reminder-id="${reminderId}">⏹️ Stop Alarm</button>
        <button class="reminder-btn reschedule" data-action="reschedule" data-reminder-id="${reminderId}">🔄 Reschedule</button>
        <button class="reminder-btn mute" data-action="mute" data-reminder-id="${reminderId}">🔇 Mute</button>
        <button class="reminder-btn settings" data-action="settings" data-reminder-id="${reminderId}">⚙️ Settings</button>
        <button class="reminder-btn dismiss" data-action="dismiss" data-reminder-id="${reminderId}">✓ Dismiss</button>
      </div>
      <div class="reminder-settings-panel hidden" data-reminder-id="${reminderId}">
        <div class="reminder-settings-title">Reminder Settings</div>
        <div class="reminder-settings-row">
          <button class="reminder-btn mute" data-action="mute" data-reminder-id="${reminderId}">🔇 Mute</button>
          <button class="reminder-btn stop-alarm" data-action="stop" data-reminder-id="${reminderId}">⏹️ Stop Alarm</button>
        </div>
        <div class="reminder-settings-row">
          <input class="reminder-reschedule-input" data-reminder-id="${reminderId}" placeholder="New time, e.g. in 10 minutes" />
          <button class="reminder-btn reschedule-now" data-action="reschedule-now" data-reminder-id="${reminderId}">Set</button>
        </div>
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

  /** Bind reminder buttons */
  _bindReminderButtons(msgEl, reminderId) {
    const stopBtn = msgEl.querySelector(`.reminder-btn.stop-alarm[data-reminder-id="${reminderId}"]`);
    const rescheduleBtn = msgEl.querySelector(`.reminder-btn.reschedule[data-reminder-id="${reminderId}"]`);
    const muteBtn = msgEl.querySelector(`.reminder-btn.mute[data-reminder-id="${reminderId}"]`);
    const settingsBtn = msgEl.querySelector(`.reminder-btn.settings[data-reminder-id="${reminderId}"]`);
    const rescheduleNowBtn = msgEl.querySelector(`.reminder-btn.reschedule-now[data-reminder-id="${reminderId}"]`);
    const dismissBtn = msgEl.querySelector(`.reminder-btn.dismiss[data-reminder-id="${reminderId}"]`);

    if (stopBtn) {
      stopBtn.addEventListener('click', () => this._handleReminderStop(reminderId, msgEl));
    }
    if (rescheduleBtn) {
      rescheduleBtn.addEventListener('click', () => this._handleReminderReschedule(reminderId, msgEl));
    }
    if (muteBtn) {
      muteBtn.addEventListener('click', () => this._handleReminderMute(reminderId, msgEl));
    }
    if (settingsBtn) {
      settingsBtn.addEventListener('click', () => this._toggleReminderSettings(reminderId, msgEl));
    }
    if (rescheduleNowBtn) {
      rescheduleNowBtn.addEventListener('click', () => this._handleReminderRescheduleNow(reminderId, msgEl));
    }
    if (dismissBtn) {
      dismissBtn.addEventListener('click', () => this._handleReminderDismiss(reminderId, msgEl));
    }
  }

  /** Handle reminder reschedule */
  _handleReminderReschedule(reminderId, msgEl) {
    const newTime = prompt('Enter new reminder time (e.g., "in 10 minutes", "tomorrow at 3pm"):');
    if (newTime) {
      this.send(`Reschedule reminder ${reminderId} to ${newTime}`);
    }
  }

  /** Handle immediate stop alarm */
  _handleReminderStop(reminderId, msgEl) {
    if (typeof window.stopReminderAlarm === 'function') {
      window.stopReminderAlarm();
    }
    const stopBtn = msgEl.querySelector(`.reminder-btn.stop-alarm[data-reminder-id="${reminderId}"]`);
    if (stopBtn) {
      stopBtn.textContent = '✔️ Alarm Stopped';
      stopBtn.disabled = true;
    }
  }

  /** Toggle reminder settings panel */
  _toggleReminderSettings(reminderId, msgEl) {
    const panel = msgEl.querySelector(`.reminder-settings-panel[data-reminder-id="${reminderId}"]`);
    if (!panel) return;
    panel.classList.toggle('hidden');
  }

  /** Handle reschedule from panel input */
  _handleReminderRescheduleNow(reminderId, msgEl) {
    const input = msgEl.querySelector(`.reminder-reschedule-input[data-reminder-id="${reminderId}"]`);
    if (!input || !input.value.trim()) {
      alert('Please enter a new reminder time.');
      return;
    }
    this.send(`Reschedule reminder ${reminderId} to ${input.value.trim()}`);
  }

  /** Handle reminder mute */
  _handleReminderMute(reminderId, msgEl) {
    window.reminderMuted = !window.reminderMuted;
    const muteBtns = msgEl.querySelectorAll(`.reminder-btn.mute[data-reminder-id="${reminderId}"]`);
    muteBtns.forEach(btn => {
      btn.textContent = window.reminderMuted ? '🔊 Unmute' : '🔇 Mute';
    });
    if (window.reminderMuted && typeof window.stopReminderAlarm === 'function') {
      window.stopReminderAlarm();
    }
    alert(`Reminders ${window.reminderMuted ? 'muted' : 'unmuted'}.`);
  }

  /** Handle reminder dismiss */
  _handleReminderDismiss(reminderId, msgEl) {
    const btns = msgEl.querySelector('.reminder-btns');
    if (btns) {
      btns.innerHTML = '<span style="color: green;">✓ Dismissed</span>';
    }
    const panel = msgEl.querySelector(`.reminder-settings-panel[data-reminder-id="${reminderId}"]`);
    if (panel) {
      panel.classList.add('hidden');
    }
    if (typeof window.stopReminderAlarm === 'function') {
      window.stopReminderAlarm();
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
        
        // If the backend provided a deep link (like wa.me), open it!
        if (data.result?.url) {
          window.open(data.result.url, '_blank');
        }
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

    // Action cards can grow after confirm/cancel; keep latest content visible above the fixed input bar.
    this._scrollToBottom();
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
        <img src="/logo.jpeg" alt="VoxFlow" class="avatar-logo" />
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

  /**
   * Clear all stored memory for this session.
   * @returns {Promise<boolean>} True if memory was cleared successfully
   */
  async clearMemory() {
    try {
      const resp = await fetch(`/api/memory/${encodeURIComponent(this.sessionId)}`, {
        method: 'DELETE',
      });

      if (!resp.ok) {
        console.error('[VoxFlow] Failed to clear memory:', resp.status);
        return false;
      }

      const data = await resp.json();
      console.log('[VoxFlow] Memory cleared:', data);

      // Show a confirmation message in the chat
      this._renderMessage('assistant', '🧠 Memory cleared! I\'ve forgotten our previous conversations. We\'re starting fresh.', {
        toolUsed: 'memory',
        queryType: 'GENERAL',
      });

      return true;
    } catch (err) {
      console.error('[VoxFlow] Memory clear error:', err);
      return false;
    }
  }
}
