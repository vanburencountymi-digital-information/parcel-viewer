/* Map Buddy — pluggable AI assistant panel for MapLibre parcel viewers
 *
 * Attach:  MapBuddy.mount({ apiBase: '/api' });
 * Detach:  MapBuddy.unmount();
 *
 * The host page only needs two lines:
 *   <script src="/map-buddy/js/map-buddy.js"></script>
 *   <script>MapBuddy.mount({ apiBase: '/api' });</script>
 *
 * Host integration surface (handled automatically by mount/unmount):
 *   - CSS injected via <link> into <head>
 *   - Panel HTML appended to #app (or opts.container)
 *   - #panel-map gets style.minWidth='0' so flex shrinks it when panel opens
 *   - window.PS_onParcelSelect chained (prior handler preserved and restored)
 *   - mcp-reopen-tab right offset nudged so it clears the panel
 */
(function (root) {
  'use strict';

  // Capture now — document.currentScript is null after the script finishes executing
  var _scriptSrc = document.currentScript ? document.currentScript.src : '';

  var STORAGE_COLLAPSED = 'mb:collapsed';
  var STORAGE_WIDTH     = 'mb:width';
  var DEFAULT_WIDTH     = 340;
  var MIN_WIDTH         = 240;
  var MAX_WIDTH         = 620;

  // Mount-time refs (null when unmounted)
  var _mounted      = false;
  var _cssLink      = null;
  var _panel        = null;
  var _panelMapEl   = null;
  var _origMinWidth = null;
  var _prevOnSelect = null;

  // Runtime state (reset by _init on each mount)
  var _apiBase, _isCollapsed, _panelWidth, _currentParcel, _history, _streaming;
  var _resizing, _startX, _startW;
  var _tabBtn, _collapseBtn, _resizeHandle, _contextEl, _contextText;
  var _messagesEl, _inputEl, _sendBtn;

  // Stored listener refs for clean removal on unmount
  var _onDocMousemove = null;
  var _onDocMouseup   = null;
  var _onPsChanged    = null;
  var _onWinResize    = null;

  var _isMobile = function () { return window.innerWidth <= 640; };

  // ── CSS URL ───────────────────────────────────────────────────────────────
  function _cssUrl() {
    if (_scriptSrc) {
      return _scriptSrc.replace(/js\/map-buddy\.js(\?.*)?$/, 'css/map-buddy.css');
    }
    return '/map-buddy/css/map-buddy.css';
  }

  // ── mount / unmount ───────────────────────────────────────────────────────
  function mount(opts) {
    if (_mounted) return;
    opts     = opts || {};
    _apiBase = opts.apiBase || root.API_BASE || '/api';

    // Inject stylesheet
    _cssLink      = document.createElement('link');
    _cssLink.rel  = 'stylesheet';
    _cssLink.href = _cssUrl();
    document.head.appendChild(_cssLink);

    // Build and inject panel
    var container = opts.container || document.getElementById('app') || document.body;
    _panel = _buildPanel();
    container.appendChild(_panel);

    // Patch host: let #panel-map shrink when Map Buddy opens
    _panelMapEl = document.getElementById('panel-map');
    if (_panelMapEl) {
      _origMinWidth = _panelMapEl.style.minWidth;
      _panelMapEl.style.minWidth = '0';
    }

    _init();
    _mounted = true;
  }

  function unmount() {
    if (!_mounted) return;

    // Remove event listeners
    if (_onDocMousemove) document.removeEventListener('mousemove', _onDocMousemove);
    if (_onDocMouseup)   document.removeEventListener('mouseup',   _onDocMouseup);
    if (_onPsChanged)    document.removeEventListener('ps:selection-changed', _onPsChanged);
    if (_onWinResize)    window.removeEventListener('resize', _onWinResize);

    // Restore parcel-select hook
    root.PS_onParcelSelect = _prevOnSelect;

    // Remove panel from DOM
    if (_panel && _panel.parentNode) _panel.parentNode.removeChild(_panel);
    _panel = null;

    // Remove injected stylesheet
    if (_cssLink && _cssLink.parentNode) _cssLink.parentNode.removeChild(_cssLink);
    _cssLink = null;

    // Restore host layout
    if (_panelMapEl) {
      _panelMapEl.style.minWidth = _origMinWidth !== null ? _origMinWidth : '';
      _panelMapEl = null;
    }

    // Reset mcp-reopen-tab offset
    var mcpTab = document.getElementById('mcp-reopen-tab');
    if (mcpTab) mcpTab.style.right = '';

    delete root.PV_MAP_BUDDY;
    _mounted = false;
  }

  // ── Panel HTML ────────────────────────────────────────────────────────────
  function _buildPanel() {
    var el = document.createElement('div');
    el.id = 'map-buddy-panel';
    el.className = 'mb-panel mb-collapsed';
    el.innerHTML =
      '<div id="mb-resize-handle" class="mb-resize-handle"' +
          ' role="separator" aria-label="Drag to resize Map Buddy panel"></div>' +
      '<button id="mb-tab-btn" class="mb-tab-btn"' +
          ' title="Open Map Buddy" aria-label="Open Map Buddy panel">' +
        '<span aria-hidden="true">✨</span><span>Map Buddy</span>' +
      '</button>' +
      '<div class="mb-drawer-handle">' +
        '<div class="mb-drawer-pill"></div>' +
        '<span class="mb-drawer-label">✨ Map Buddy</span>' +
        '<div class="mb-drawer-pill"></div>' +
      '</div>' +
      '<div class="mb-inner">' +
        '<div class="mb-header">' +
          '<span class="mb-header-icon" aria-hidden="true">✨</span>' +
          '<span class="mb-header-title">Map Buddy</span>' +
          '<button id="mb-collapse-btn" class="mb-collapse-btn"' +
              ' title="Collapse panel" aria-label="Collapse Map Buddy">❮</button>' +
        '</div>' +
        '<div id="mb-context" class="mb-context mb-context-empty">' +
          '<span class="mb-context-dot"></span>' +
          '<span id="mb-context-text">No parcel selected</span>' +
        '</div>' +
        '<div id="mb-messages" class="mb-messages"' +
            ' role="log" aria-live="polite" aria-label="Map Buddy conversation"></div>' +
        '<div class="mb-input-area">' +
          '<textarea id="mb-input" class="mb-input" rows="1"' +
              ' placeholder="Ask about this parcel or search by owner…"' +
              ' aria-label="Message Map Buddy"></textarea>' +
          '<button id="mb-send-btn" class="mb-send-btn" aria-label="Send">' +
            '<svg width="13" height="13" viewBox="0 0 13 13"' +
                ' fill="currentColor" aria-hidden="true">' +
              '<path d="M1.5 6.5 L11.5 1 L8.5 6.5 L11.5 12 Z"/>' +
            '</svg>' +
          '</button>' +
        '</div>' +
      '</div>';
    return el;
  }

  // ── Wire up UI ────────────────────────────────────────────────────────────
  function _init() {
    _tabBtn       = document.getElementById('mb-tab-btn');
    _collapseBtn  = document.getElementById('mb-collapse-btn');
    _resizeHandle = document.getElementById('mb-resize-handle');
    _contextEl    = document.getElementById('mb-context');
    _contextText  = document.getElementById('mb-context-text');
    _messagesEl   = document.getElementById('mb-messages');
    _inputEl      = document.getElementById('mb-input');
    _sendBtn      = document.getElementById('mb-send-btn');

    _isCollapsed   = true;
    _panelWidth    = DEFAULT_WIDTH;
    _currentParcel = null;
    _history       = [];
    _streaming     = false;
    _resizing      = false;

    var savedW = parseInt(localStorage.getItem(STORAGE_WIDTH), 10);
    if (savedW && !isNaN(savedW)) {
      _panelWidth = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, savedW));
    }

    if (localStorage.getItem(STORAGE_COLLAPSED) === 'false') {
      _openPanel(true);
    } else {
      _collapsePanel(true);
    }

    var drawerHandle = _panel.querySelector('.mb-drawer-handle');
    if (drawerHandle) drawerHandle.addEventListener('click', _togglePanel);
    _tabBtn.addEventListener('click', _openPanel);
    _collapseBtn.addEventListener('click', _collapsePanel);

    // Drag-resize
    _resizeHandle.addEventListener('mousedown', function (e) {
      if (_isCollapsed || _isMobile()) return;
      _resizing = true;
      _startX   = e.clientX;
      _startW   = _panel.offsetWidth;
      _panel.classList.add('mb-resizing');
      document.body.style.cursor     = 'col-resize';
      document.body.style.userSelect = 'none';
      var mapEl = document.getElementById('map');
      if (mapEl) mapEl.style.pointerEvents = 'none';
      e.preventDefault();
    });

    _onDocMousemove = function (e) {
      if (!_resizing) return;
      var delta = _startX - e.clientX;
      _panelWidth = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, _startW + delta));
      _panel.style.width = _panelWidth + 'px';
      _nudgeMcpTab();
    };
    document.addEventListener('mousemove', _onDocMousemove);

    _onDocMouseup = function () {
      if (!_resizing) return;
      _resizing = false;
      _panel.classList.remove('mb-resizing');
      document.body.style.cursor     = '';
      document.body.style.userSelect = '';
      var mapEl = document.getElementById('map');
      if (mapEl) mapEl.style.pointerEvents = '';
      localStorage.setItem(STORAGE_WIDTH, String(_panelWidth));
    };
    document.addEventListener('mouseup', _onDocMouseup);

    // Parcel context — chain onto any existing handler
    _prevOnSelect = root.PS_onParcelSelect || null;
    root.PS_onParcelSelect = function (parcel) {
      if (_prevOnSelect) _prevOnSelect(parcel);
      _currentParcel = parcel;
      _refreshContext();
    };

    _onPsChanged = function () {
      if (!root.PS_STATE || !root.PS_STATE.parcel) {
        _currentParcel = null;
        _refreshContext();
      }
    };
    document.addEventListener('ps:selection-changed', _onPsChanged);

    // Textarea auto-grow + send
    _inputEl.addEventListener('input', function () {
      _inputEl.style.height = 'auto';
      _inputEl.style.height = Math.min(100, _inputEl.scrollHeight) + 'px';
    });
    _inputEl.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); _send(); }
    });
    _sendBtn.addEventListener('click', _send);

    _onWinResize = function () { _applyWidth(); _nudgeMcpTab(); };
    window.addEventListener('resize', _onWinResize);

    _renderEmptyState();

    root.PV_MAP_BUDDY = {
      open:     _openPanel,
      collapse: _collapsePanel,
      ask: function (q) {
        if (!_isCollapsed) { _inputEl.value = q; _send(); }
        else { _openPanel(); _inputEl.value = q; _send(); }
      },
    };
  }

  // ── Open / collapse ───────────────────────────────────────────────────────
  function _openPanel() {
    _isCollapsed = false;
    _panel.classList.remove('mb-collapsed');
    if (!_isMobile()) _applyWidth();
    localStorage.setItem(STORAGE_COLLAPSED, 'false');
    _nudgeMcpTab();
  }

  function _collapsePanel() {
    _isCollapsed = true;
    _panel.classList.add('mb-collapsed');
    if (!_isMobile()) _panel.style.width = '';
    localStorage.setItem(STORAGE_COLLAPSED, 'true');
    _nudgeMcpTab();
  }

  function _togglePanel() {
    if (_isCollapsed) _openPanel(); else _collapsePanel();
  }

  function _applyWidth() {
    if (!_isCollapsed && !_isMobile()) {
      _panel.style.width = _panelWidth + 'px';
    }
  }

  function _nudgeMcpTab() {
    var mcpTab = document.getElementById('mcp-reopen-tab');
    if (!mcpTab || _isMobile()) return;
    mcpTab.style.right = (_isCollapsed ? 28 : _panelWidth) + 'px';
  }

  // ── Parcel context pill ───────────────────────────────────────────────────
  function _refreshContext() {
    if (_currentParcel) {
      _contextEl.classList.remove('mb-context-empty');
      var acres = _currentParcel.acres != null
        ? ' · ' + _currentParcel.acres.toFixed(1) + ' ac' : '';
      var owner = _currentParcel.owner_name
        ? ' · ' + _currentParcel.owner_name.split(' ').slice(0, 2).join(' ') : '';
      _contextText.textContent = _currentParcel.pin + acres + owner;
      if (!_streaming) _inputEl.placeholder = 'Ask about parcel ' + _currentParcel.pin + '…';
    } else {
      _contextEl.classList.add('mb-context-empty');
      _contextText.textContent = 'No parcel selected';
      if (!_streaming) _inputEl.placeholder = 'Ask me to find a parcel, or ask a general question…';
    }
  }

  // ── Send ──────────────────────────────────────────────────────────────────
  function _send() {
    var text = _inputEl.value.trim();
    if (!text || _streaming) return;

    var emptyState = _messagesEl.querySelector('.mb-empty-state');
    if (emptyState) emptyState.remove();

    _appendUserMsg(text);
    _inputEl.value       = '';
    _inputEl.style.height = '';
    _sendBtn.disabled    = true;
    _streaming           = true;

    _streamChat(text).then(
      function () { _sendBtn.disabled = false; _streaming = false; },
      function () { _sendBtn.disabled = false; _streaming = false; }
    );
  }

  // ── Message rendering ─────────────────────────────────────────────────────
  function _appendUserMsg(text) {
    var el = document.createElement('div');
    el.className   = 'mb-msg-user';
    el.textContent = text;
    _messagesEl.appendChild(el);
    _scrollBottom();
  }

  function _appendAiMsg(text) {
    var el   = document.createElement('div');
    el.className = 'mb-msg-ai';
    var lbl  = document.createElement('div');
    lbl.className   = 'mb-msg-ai-label';
    lbl.textContent = 'Map Buddy';
    var body = document.createElement('div');
    body.className   = 'mb-msg-ai-body';
    body.textContent = text;
    el.appendChild(lbl);
    el.appendChild(body);
    _messagesEl.appendChild(el);
    _scrollBottom();
    return el;
  }

  function _showThinking() {
    var el = document.createElement('div');
    el.className = 'mb-thinking';
    el.innerHTML =
      'Thinking… ' +
      '<span class="mb-thinking-dots">' +
        '<span class="mb-thinking-dot"></span>' +
        '<span class="mb-thinking-dot"></span>' +
        '<span class="mb-thinking-dot"></span>' +
      '</span>';
    _messagesEl.appendChild(el);
    _scrollBottom();
    return el;
  }

  function _updateThinking(el, msg) {
    var dots = el.querySelector('.mb-thinking-dots');
    el.textContent = msg + ' ';
    if (dots) el.appendChild(dots);
    _scrollBottom();
  }

  function _scrollBottom() {
    _messagesEl.scrollTop = _messagesEl.scrollHeight;
  }

  // ── SSE streaming ─────────────────────────────────────────────────────────
  function _streamChat(userMessage) {
    var thinkEl = _showThinking();
    var payload = {
      message:              userMessage,
      conversation_history: _history.slice(-12),
      parcel_context:       _currentParcel ? _buildContext() : null,
    };

    return fetch(_apiBase + '/chat', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var reader  = res.body.getReader();
      var decoder = new TextDecoder();
      var buf     = '';

      function pump() {
        return reader.read().then(function (chunk) {
          if (chunk.done) return;
          buf += decoder.decode(chunk.value, { stream: true });
          var lines = buf.split('\n');
          buf = lines.pop();

          for (var i = 0; i < lines.length; i++) {
            var line = lines[i];
            if (line.indexOf('data: ') !== 0) continue;
            var raw = line.slice(6).trim();
            if (!raw || raw === '[DONE]') continue;
            var evt;
            try { evt = JSON.parse(raw); } catch (e) { continue; }

            if (evt.type === 'status') {
              _updateThinking(thinkEl, evt.message);
            } else if (evt.type === 'done') {
              thinkEl.remove();
              var responseText = evt.response_text || '';
              _appendAiMsg(responseText);
              _history.push({ role: 'user',      content: userMessage   });
              _history.push({ role: 'assistant', content: responseText  });
              if (evt.commands && evt.commands.length) _runCommands(evt.commands);
            } else if (evt.type === 'error') {
              thinkEl.remove();
              _appendAiMsg('Sorry, something went wrong: ' + evt.message);
            }
          }
          return pump();
        });
      }
      return pump();

    }).catch(function (err) {
      thinkEl.remove();
      if (err.message && err.message.indexOf('404') !== -1) {
        _appendAiMsg('The AI backend isn’t connected yet. Check back soon!');
      } else {
        _appendAiMsg('Couldn’t reach the server. Please try again.');
      }
      console.error('[Map Buddy]', err);
    });
  }

  function _buildContext() {
    var p = _currentParcel;
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
  function _runCommands(cmds) {
    for (var i = 0; i < cmds.length; i++) {
      var cmd = cmds[i];
      try {
        switch (cmd.type) {
          case 'highlight_parcel':
            if (root.PS_highlightParcel) root.PS_highlightParcel(cmd.payload.pin);
            break;
          case 'select_parcel_on_map':
            if (root.PS_selectParcel) root.PS_selectParcel(cmd.payload.pin);
            break;
          case 'fit_map_to_parcel':
            if (root.PS_zoomToParcel) root.PS_zoomToParcel();
            break;
          case 'set_layer_visibility':
            _setOverlay(cmd.payload.layer_id, cmd.payload.visible);
            break;
        }
      } catch (e) {
        console.warn('[Map Buddy] command error', cmd, e);
      }
    }
  }

  function _setOverlay(layerId, visible) {
    var cb = document.getElementById('overlay-' + layerId + '-toggle');
    if (cb && cb.checked !== visible) {
      cb.checked = visible;
      cb.dispatchEvent(new Event('change'));
    }
  }

  // ── Welcome / empty state ─────────────────────────────────────────────────
  function _renderEmptyState() {
    var el = document.createElement('div');
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

    var btns = el.querySelectorAll('.mb-quick-btn');
    for (var i = 0; i < btns.length; i++) {
      (function (btn) {
        btn.addEventListener('click', function () {
          _inputEl.value = btn.textContent;
          _send();
        });
      })(btns[i]);
    }
    _messagesEl.appendChild(el);
  }

  // ── Public API ────────────────────────────────────────────────────────────
  root.MapBuddy = { mount: mount, unmount: unmount };

})(window);
