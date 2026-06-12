/* Map Buddy — AI assistant panel
 * Handles: open/collapse, drag-resize, localStorage persistence,
 *          parcel context tracking, SSE streaming chat, map command dispatch.
 */
(function () {
  'use strict';

  const STORAGE_COLLAPSED = 'mb:collapsed';
  const STORAGE_WIDTH     = 'mb:width';
  const DEFAULT_WIDTH     = 340;
  const MIN_WIDTH         = 240;
  const MAX_WIDTH         = 620;

  // ── Element refs ──────────────────────────────────────────────────────────
  const panel       = document.getElementById('map-buddy-panel');
  const tabBtn      = document.getElementById('mb-tab-btn');
  const collapseBtn = document.getElementById('mb-collapse-btn');
  const resizeHandle= document.getElementById('mb-resize-handle');
  const contextEl   = document.getElementById('mb-context');
  const contextText = document.getElementById('mb-context-text');
  const messagesEl  = document.getElementById('mb-messages');
  const inputEl     = document.getElementById('mb-input');
  const sendBtn     = document.getElementById('mb-send-btn');

  if (!panel) return; // guard: HTML not present

  // ── State ─────────────────────────────────────────────────────────────────
  let isCollapsed  = true;
  let panelWidth   = DEFAULT_WIDTH;
  let currentParcel= null;
  let history      = [];   // { role, content }[]
  let streaming    = false;

  const isMobile   = () => window.innerWidth <= 640;

  // ── Add mobile drawer handle to HTML (mobile-only element) ───────────────
  const drawerHandle = document.createElement('div');
  drawerHandle.className = 'mb-drawer-handle';
  drawerHandle.innerHTML =
    '<div class="mb-drawer-pill"></div>' +
    '<span class="mb-drawer-label">✨ Map Buddy</span>' +
    '<div class="mb-drawer-pill"></div>';
  panel.insertBefore(drawerHandle, panel.querySelector('.mb-inner'));
  drawerHandle.addEventListener('click', togglePanel);

  // ── Restore from localStorage ─────────────────────────────────────────────
  const savedWidth = parseInt(localStorage.getItem(STORAGE_WIDTH), 10);
  if (savedWidth && !isNaN(savedWidth)) {
    panelWidth = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, savedWidth));
  }

  if (localStorage.getItem(STORAGE_COLLAPSED) === 'false') {
    openPanel(true);
  } else {
    collapsePanel(true);
  }

  // ── Panel open / collapse ─────────────────────────────────────────────────
  function openPanel(instant) {
    isCollapsed = false;
    panel.classList.remove('mb-collapsed');
    if (!isMobile()) applyWidth();
    localStorage.setItem(STORAGE_COLLAPSED, 'false');
    nudgeMcpTab();
  }

  function collapsePanel(instant) {
    isCollapsed = true;
    panel.classList.add('mb-collapsed');
    if (!isMobile()) panel.style.width = '';
    localStorage.setItem(STORAGE_COLLAPSED, 'true');
    nudgeMcpTab();
  }

  function togglePanel() {
    if (isCollapsed) openPanel(); else collapsePanel();
  }

  function applyWidth() {
    if (!isCollapsed && !isMobile()) {
      panel.style.width = panelWidth + 'px';
    }
  }

  // Keep mcp-reopen-tab from sitting behind Map Buddy panel
  function nudgeMcpTab() {
    const mcpTab = document.getElementById('mcp-reopen-tab');
    if (!mcpTab || isMobile()) return;
    const offset = isCollapsed ? 28 : panelWidth;
    mcpTab.style.right = offset + 'px';
  }

  tabBtn.addEventListener('click', openPanel);
  collapseBtn.addEventListener('click', collapsePanel);

  // ── Drag-resize ───────────────────────────────────────────────────────────
  let resizing = false, startX = 0, startW = 0;

  resizeHandle.addEventListener('mousedown', e => {
    if (isCollapsed || isMobile()) return;
    resizing = true;
    startX = e.clientX;
    startW = panel.offsetWidth;
    panel.classList.add('mb-resizing');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    const mapEl = document.getElementById('map');
    if (mapEl) mapEl.style.pointerEvents = 'none';
    e.preventDefault();
  });

  document.addEventListener('mousemove', e => {
    if (!resizing) return;
    const delta  = startX - e.clientX; // drag left → panel widens
    panelWidth   = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startW + delta));
    panel.style.width = panelWidth + 'px';
    nudgeMcpTab();
  });

  document.addEventListener('mouseup', () => {
    if (!resizing) return;
    resizing = false;
    panel.classList.remove('mb-resizing');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    const mapEl = document.getElementById('map');
    if (mapEl) mapEl.style.pointerEvents = '';
    localStorage.setItem(STORAGE_WIDTH, panelWidth);
  });

  // ── Parcel context ────────────────────────────────────────────────────────
  // Chain onto any existing PS_onParcelSelect handler
  const _prevOnSelect = window.PS_onParcelSelect;
  window.PS_onParcelSelect = function (parcel) {
    if (_prevOnSelect) _prevOnSelect(parcel);
    currentParcel = parcel;
    refreshContext();
  };

  document.addEventListener('ps:selection-changed', () => {
    if (!window.PS_STATE || !window.PS_STATE.parcel) {
      currentParcel = null;
      refreshContext();
    }
  });

  function refreshContext() {
    if (currentParcel) {
      contextEl.classList.remove('mb-context-empty');
      const acres = currentParcel.acres != null
        ? ' · ' + currentParcel.acres.toFixed(1) + ' ac' : '';
      const owner = currentParcel.owner_name
        ? ' · ' + currentParcel.owner_name.split(' ').slice(0, 2).join(' ') : '';
      contextText.textContent = currentParcel.pin + acres + owner;
      if (!streaming) inputEl.placeholder = 'Ask about parcel ' + currentParcel.pin + '…';
    } else {
      contextEl.classList.add('mb-context-empty');
      contextText.textContent = 'No parcel selected';
      if (!streaming) inputEl.placeholder = 'Ask me to find a parcel, or ask a general question…';
    }
  }

  // ── Auto-grow textarea ────────────────────────────────────────────────────
  inputEl.addEventListener('input', () => {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(100, inputEl.scrollHeight) + 'px';
  });

  inputEl.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });

  sendBtn.addEventListener('click', send);

  // ── Send / receive ────────────────────────────────────────────────────────
  function send() {
    const text = inputEl.value.trim();
    if (!text || streaming) return;

    // Remove empty state on first message
    const emptyState = messagesEl.querySelector('.mb-empty-state');
    if (emptyState) emptyState.remove();

    appendUserMsg(text);
    inputEl.value = '';
    inputEl.style.height = '';
    sendBtn.disabled = true;
    streaming = true;

    streamChat(text).finally(() => {
      sendBtn.disabled = false;
      streaming = false;
    });
  }

  // ── Message rendering ─────────────────────────────────────────────────────
  function appendUserMsg(text) {
    const el = document.createElement('div');
    el.className = 'mb-msg-user';
    el.textContent = text;
    messagesEl.appendChild(el);
    scrollBottom();
    return el;
  }

  function appendAiMsg(text) {
    const el = document.createElement('div');
    el.className = 'mb-msg-ai';
    const lbl = document.createElement('div');
    lbl.className = 'mb-msg-ai-label';
    lbl.textContent = 'Map Buddy';
    const body = document.createElement('div');
    body.className = 'mb-msg-ai-body';
    body.textContent = text;
    el.append(lbl, body);
    messagesEl.appendChild(el);
    scrollBottom();
    return el;
  }

  function showThinking() {
    const el = document.createElement('div');
    el.className = 'mb-thinking';
    el.innerHTML = 'Thinking… ' +
      '<span class="mb-thinking-dots">' +
        '<span class="mb-thinking-dot"></span>' +
        '<span class="mb-thinking-dot"></span>' +
        '<span class="mb-thinking-dot"></span>' +
      '</span>';
    messagesEl.appendChild(el);
    scrollBottom();
    return el;
  }

  function updateThinking(el, msg) {
    const dots = el.querySelector('.mb-thinking-dots');
    el.textContent = msg + ' ';
    if (dots) el.appendChild(dots);
    scrollBottom();
  }

  function scrollBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  // ── SSE streaming chat ────────────────────────────────────────────────────
  async function streamChat(userMessage) {
    const thinkEl = showThinking();
    const apiBase = window.API_BASE || '/api';

    const payload = {
      message: userMessage,
      conversation_history: history.slice(-12),
      parcel_context: currentParcel ? buildContext() : null,
    };

    try {
      const res = await fetch(apiBase + '/chat', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(payload),
      });

      if (!res.ok) throw new Error('HTTP ' + res.status);

      const reader  = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });

        const lines = buf.split('\n');
        buf = lines.pop(); // hold incomplete line

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const raw = line.slice(6).trim();
          if (!raw || raw === '[DONE]') continue;
          let evt;
          try { evt = JSON.parse(raw); } catch { continue; }

          if (evt.type === 'status') {
            updateThinking(thinkEl, evt.message);

          } else if (evt.type === 'done') {
            thinkEl.remove();
            const responseText = evt.response_text || '';
            appendAiMsg(responseText);
            history.push({ role: 'user', content: userMessage });
            history.push({ role: 'assistant', content: responseText });
            if (evt.commands && evt.commands.length) runCommands(evt.commands);

          } else if (evt.type === 'error') {
            thinkEl.remove();
            appendAiMsg('Sorry, something went wrong: ' + evt.message);
          }
        }
      }

    } catch (err) {
      thinkEl.remove();
      if (err.message && err.message.includes('404')) {
        appendAiMsg('The AI backend isn\'t connected yet. Check back soon!');
      } else {
        appendAiMsg('Couldn\'t reach the server. Please try again.');
      }
      console.error('[Map Buddy]', err);
    }
  }

  function buildContext() {
    const p = currentParcel;
    return {
      pin:          p.pin,
      acres:        p.acres,
      owner_name:   p.owner_name,
      site_address: p.site_address,
      municipality: p.municipality,
      centroid:     p.centroid,
      bbox:         p.bbox,
    };
  }

  // ── Map command dispatch ──────────────────────────────────────────────────
  function runCommands(cmds) {
    cmds.forEach(cmd => {
      try {
        switch (cmd.type) {
          case 'highlight_parcel':
            if (window.PS_highlightParcel) window.PS_highlightParcel(cmd.payload.pin);
            break;
          case 'select_parcel_on_map':
            if (window.PS_selectParcel) window.PS_selectParcel(cmd.payload.pin);
            break;
          case 'fit_map_to_parcel':
            if (window.PS_zoomToParcel) window.PS_zoomToParcel();
            break;
          case 'set_layer_visibility':
            setOverlay(cmd.payload.layer_id, cmd.payload.visible);
            break;
        }
      } catch (e) {
        console.warn('[Map Buddy] command error', cmd, e);
      }
    });
  }

  function setOverlay(layerId, visible) {
    const cb = document.getElementById('overlay-' + layerId + '-toggle');
    if (cb && cb.checked !== visible) {
      cb.checked = visible;
      cb.dispatchEvent(new Event('change'));
    }
  }

  // ── Welcome / empty state ─────────────────────────────────────────────────
  (function renderEmptyState() {
    const el = document.createElement('div');
    el.className = 'mb-empty-state';
    el.innerHTML =
      '<div class="mb-empty-icon">✨</div>' +
      '<div class="mb-empty-title">Map Buddy</div>' +
      '<div class="mb-empty-hint">Select a parcel and ask me anything about it, ' +
        'or search for one by owner name or address.</div>' +
      '<div class="mb-quick-btns">' +
        '<button class="mb-quick-btn">What is Taxable Value vs. Assessed Value?</button>' +
        '<button class="mb-quick-btn">How does the Headlee Amendment work?</button>' +
        '<button class="mb-quick-btn">What does PRE mean?</button>' +
      '</div>';

    el.querySelectorAll('.mb-quick-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        inputEl.value = btn.textContent;
        send();
      });
    });

    messagesEl.appendChild(el);
  })();

  // ── Window resize: re-apply layout ───────────────────────────────────────
  window.addEventListener('resize', () => {
    applyWidth();
    nudgeMcpTab();
  });

  // ── Public API ────────────────────────────────────────────────────────────
  window.PV_MAP_BUDDY = {
    open:     openPanel,
    collapse: collapsePanel,
    ask:      (q) => { if (!isCollapsed) { inputEl.value = q; send(); } else { openPanel(); inputEl.value = q; send(); } },
  };

})();
