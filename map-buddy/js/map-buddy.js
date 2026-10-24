/* Map Buddy — pluggable AI assistant panel for MapLibre parcel viewers
 *
 * Attach:  MapBuddy.mount({ apiBase: '/api' });
 * Detach:  MapBuddy.unmount();
 *
 * The host page needs the map commands, the panel, and a mount:
 *   <script src="/map-buddy/js/map-buddy-commands.js"></script>
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

  // Capture now — document.currentScript is null after the script finishes executing.
  // Only trusted when it IS map-buddy.js: inside the viewer's build bundle (DIC-2180) it
  // is /assets/scripts-….js, and the stylesheet is at the default path.
  var _script = document.currentScript;
  var _scriptSrc = _script && /js\/map-buddy\.js(\?.*)?$/.test(_script.src) ? _script.src : '';

  var STORAGE_COLLAPSED = 'mb:collapsed';
  var STORAGE_WIDTH     = 'mb:width';
  var DEFAULT_WIDTH     = 340;
  // Chat request ceiling and per-turn history cap (server rejects turns > 8000 chars).
  var CHAT_TIMEOUT_MS   = 120000;
  var HISTORY_MAX_CHARS = 6000;
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
  var _messagesEl, _inputEl, _sendBtn, _lookBtn;
  // Map vision (DIC-2135): a look the AI asked for runs after its reply finishes, and the
  // AI may offer a look at most once per conversation (each look is a paid model call).
  var _pendingLook, _visionOffered;
  // The map commands (map-buddy-commands.js), created on mount with this panel's adapter.
  var _cmd = null;

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

    _cmd = root.PV_MAP_BUDDY_COMMANDS.create({
      currentParcel: function () { return _currentParcel; },
      info:          _appendInfoBubble,
      results:       _appendResultBubble,
      suggest:       _appendSuggestions,
      requestLook:   function (q) { _pendingLook = { question: q }; },
      offerLook:     function (q) {
        if (_visionOffered) return;   // never a second offer in one conversation
        _visionOffered = true;
        _appendLookOffer(q);
      },
    });
    _init();
    _loadAutomations();

    // Programmatic surface: lets the host (or the AI command path) drive the map
    // and inspect view state. unmount() tears this down. MERGE into the panel API
    // _init() already published (open/collapse/toggle/isOpen/ask): replacing it broke
    // the mobile Map Buddy tab and the "Ask Map Buddy" hint (DIC-1873).
    root.PV_MAP_BUDDY = Object.assign(root.PV_MAP_BUDDY || {}, {
      runCommands:   _cmd.run,
      buildMapState: _cmd.buildMapState,
      send:          function (t) { if (_inputEl) { _inputEl.value = t; _send(); } },
    });

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
    _cmd = null;
    _mounted = false;
  }

  // ── Panel HTML ────────────────────────────────────────────────────────────
  function _buildPanel() {
    var el = document.createElement('div');
    el.id = 'map-buddy-panel';
    el.className = 'mb-panel mb-collapsed';
    el.innerHTML =
      '<div id="mb-resize-handle" class="mb-resize-handle"' +
          ' role="separator" aria-label="Drag to resize MapBuddy A.I. panel"></div>' +
      '<button id="mb-tab-btn" class="mb-tab-btn"' +
          ' title="Open MapBuddy A.I." aria-label="Open MapBuddy A.I. panel">' +
        '<span>MapBuddy A.I.</span>' +
      '</button>' +
      '<div class="mb-drawer-handle">' +
        '<div class="mb-drawer-pill"></div>' +
        '<span class="mb-drawer-label">MapBuddy A.I.</span>' +
        '<div class="mb-drawer-pill"></div>' +
        '<button id="mb-mobile-close" class="mb-mobile-close"' +
            ' title="Close" aria-label="Close MapBuddy A.I.">✕</button>' +
      '</div>' +
      '<div class="mb-inner">' +
        '<div class="mb-header">' +
          '<span class="mb-header-title">MapBuddy A.I.</span>' +
          '<button id="mb-collapse-btn" class="mb-collapse-btn"' +
              ' title="Collapse panel" aria-label="Collapse MapBuddy A.I.">❮</button>' +
        '</div>' +
        '<div id="mb-context" class="mb-context mb-context-empty">' +
          '<span class="mb-context-dot"></span>' +
          '<span id="mb-context-text">No parcel selected</span>' +
          '<button id="mb-look-btn" class="mb-look-btn" type="button"' +
              ' title="An AI image model describes the map as you see it">Describe this view</button>' +
        '</div>' +
        '<div id="mb-automations" class="mb-automations" hidden></div>' +
        '<div id="mb-messages" class="mb-messages"' +
            ' role="log" aria-live="polite" aria-label="MapBuddy A.I. conversation"></div>' +
        '<div class="mb-input-area">' +
          '<textarea id="mb-input" class="mb-input" rows="1" maxlength="2000"' +
              ' placeholder="Ask about this parcel or search by owner…"' +
              ' aria-label="Message MapBuddy A.I."></textarea>' +
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
    _lookBtn      = document.getElementById('mb-look-btn');

    _isCollapsed   = true;
    _panelWidth    = DEFAULT_WIDTH;
    _currentParcel = null;
    _history       = [];
    _streaming     = false;
    _resizing      = false;
    _pendingLook   = null;
    _visionOffered = false;

    var savedW = parseInt(localStorage.getItem(STORAGE_WIDTH), 10);
    if (savedW && !isNaN(savedW)) {
      _panelWidth = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, savedW));
    }

    // On mobile, always start collapsed (the unified tab bar reopens it) so the
    // viewer loads with all panels closed. Desktop restores the saved state.
    if (!_isMobile() && localStorage.getItem(STORAGE_COLLAPSED) === 'false') {
      _openPanel();
    } else {
      _collapsePanel();
    }

    var drawerHandle = _panel.querySelector('.mb-drawer-handle');
    if (drawerHandle) drawerHandle.addEventListener('click', _togglePanel);
    var mobileClose = document.getElementById('mb-mobile-close');
    if (mobileClose) mobileClose.addEventListener('click', function (e) {
      e.stopPropagation();           // don't also trigger the drawer-handle toggle
      _collapsePanel();
    });
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
      _refreshEmptyState();   // freshly-selected parcel → parcel-specific ideas
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
    _lookBtn.addEventListener('click', function () {
      _startLook({ question: null, userLabel: 'Describe this view' });
    });

    _onWinResize = function () {
      _applyWidth();
      _nudgeMcpTab();
      // Keep the mobile split-screen push class consistent across breakpoint
      // changes (e.g. rotate/resize): only mobile + open should push the map.
      if (!_isMobile()) document.body.classList.remove('mb-mobile-open');
      else document.body.classList.toggle('mb-mobile-open', !_isCollapsed);
    };
    window.addEventListener('resize', _onWinResize);

    _renderEmptyState();

    root.PV_MAP_BUDDY = {
      open:     _openPanel,
      collapse: _collapsePanel,
      toggle:   _togglePanel,
      isOpen:   function () { return !_isCollapsed; },
      ask: function (q) {
        if (!_isCollapsed) { _inputEl.value = q; _send(); }
        else { _openPanel(); _inputEl.value = q; _send(); }
      },
      // An explicit "look at the map" from another control (the right-click menu).
      lookAtMap: function (question, userLabel) {
        if (_isCollapsed) _openPanel();
        return _startLook({ question: question || null, userLabel: userLabel || 'Describe this view' });
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
    _pushMap(true);
  }

  function _collapsePanel() {
    _isCollapsed = true;
    _panel.classList.add('mb-collapsed');
    if (!_isMobile()) _panel.style.width = '';
    localStorage.setItem(STORAGE_COLLAPSED, 'true');
    _nudgeMcpTab();
    _pushMap(false);
  }

  // Mobile split-screen: toggle the body class that shrinks #panel-map into the
  // top half, then refit the MapLibre canvas to the new container size. No-op on
  // desktop layout. Fires a few times because the map handle (PS_MAP) is only
  // published after the map's 'load' event, which may lag a first open.
  function _pushMap(open) {
    document.body.classList.toggle('mb-mobile-open', open && _isMobile());
    var fit = function () {
      var map = root.PS_MAP;
      if (map && typeof map.resize === 'function') map.resize();
      else window.dispatchEvent(new Event('resize')); // fallback: MapLibre trackResize
    };
    fit();
    setTimeout(fit, 80);
    setTimeout(fit, 260);
    if (root.PV_MOBILE_TABS && root.PV_MOBILE_TABS.refresh) root.PV_MOBILE_TABS.refresh();
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
    _lookBtn.disabled    = true;
    _streaming           = true;

    var finish = function () { _sendBtn.disabled = false; _lookBtn.disabled = false; _streaming = false; };
    _streamChat(text).then(finish, finish);
  }

  // ── Message rendering ─────────────────────────────────────────────────────

  // Minimal, safe Markdown → HTML for AI replies. The model returns Markdown
  // (bold, bullet/numbered lists, paragraphs), which we were dumping verbatim
  // via textContent — so it showed literal "**" and "-" with no structure.
  // We escape HTML first, then apply a limited formatting set; no raw-HTML
  // passthrough, since LLM output is untrusted.
  function _escHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  // Strip a leading icon/emoji (and its trailing space) — the chat reads cleaner
  // and less cartoonish without them.
  function _deIcon(s) { return String(s == null ? '' : s).replace(/^[^\w]+/, '').trim(); }
  function _inlineMd(s) {
    return s
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
      .replace(/\b_([^_\n]+)_\b/g, '<em>$1</em>');
  }
  // Line-based so it's robust to the model's inconsistent blank-line usage:
  // headings (#, or a line that's just a bold label) become subheads, bullet /
  // numbered runs become lists, and consecutive plain lines merge into one
  // paragraph. Everything is escaped first; no raw-HTML passthrough.
  function _renderMarkdown(text) {
    var src = _escHtml(text).replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    if (!src) return '';
    var lines = src.split('\n'), html = '', list = null;
    function closeList() { if (list) { html += '</' + list + '>'; list = null; } }
    var isBreak = function (s) { return !s || /^(#{1,6}\s|[-*]\s|\d+\.\s)/.test(s) || /^\*\*[^*]+\*\*:?$/.test(s); };
    for (var i = 0; i < lines.length; i++) {
      var raw = lines[i].trim();
      if (!raw) { closeList(); continue; }
      var mH = raw.match(/^#{1,6}\s+(.*)$/);
      var mUL = raw.match(/^[-*]\s+(.*)$/);
      var mOL = raw.match(/^\d+\.\s+(.*)$/);
      if (mH || /^\*\*[^*]+\*\*:?$/.test(raw)) {
        closeList();
        html += '<div class="mb-h">' + _inlineMd((mH ? mH[1] : raw).replace(/:$/, '')) + '</div>';
      } else if (mUL) {
        if (list !== 'ul') { closeList(); html += '<ul>'; list = 'ul'; }
        html += '<li>' + _inlineMd(mUL[1]) + '</li>';
      } else if (mOL) {
        if (list !== 'ol') { closeList(); html += '<ol>'; list = 'ol'; }
        html += '<li>' + _inlineMd(mOL[1]) + '</li>';
      } else {
        closeList();
        var para = [_inlineMd(raw)];
        while (i + 1 < lines.length && !isBreak(lines[i + 1].trim())) { para.push(_inlineMd(lines[++i].trim())); }
        html += '<p>' + para.join('<br>') + '</p>';
      }
    }
    closeList();
    return html;
  }

  function _appendUserMsg(text) {
    var el = document.createElement('div');
    el.className   = 'mb-msg-user';
    el.dataset.testid = 'mb-msg-user';   // e2e (DIC-2180): one test id per message kind
    el.textContent = text;
    _messagesEl.appendChild(el);
    _scrollBottom();
  }

  function _appendAiMsg(text) {
    var el   = document.createElement('div');
    el.className = 'mb-msg-ai';
    el.dataset.testid = 'mb-msg-ai';
    var lbl  = document.createElement('div');
    lbl.className   = 'mb-msg-ai-label';
    lbl.dataset.testid = 'mb-msg-label';
    lbl.textContent = 'MapBuddy A.I.';
    var body = document.createElement('div');
    body.className   = 'mb-msg-ai-body';
    body.dataset.testid = 'mb-msg-body';
    body.innerHTML   = _renderMarkdown(text);
    el.appendChild(lbl);
    el.appendChild(body);
    _messagesEl.appendChild(el);
    _scrollBottom();
    return el;
  }

  function _showThinking() {
    var el = document.createElement('div');
    el.className = 'mb-thinking';
    el.dataset.testid = 'mb-thinking';
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
  // opts.visionRead: the look this turn answers from (DIC-2135).
  function _streamChat(userMessage, opts) {
    opts = opts || {};
    var thinkEl = _showThinking();
    var payload = {
      message:              userMessage,
      conversation_history: _history.slice(-12),
      parcel_context:       _currentParcel ? _buildContext() : null,
      map_state:            _cmd.buildMapState(),
      vision_offered:       _visionOffered,
    };
    if (opts.visionRead) payload.vision_read = opts.visionRead;

    // A request can legitimately take a while (several tool rounds), but never forever:
    // abort so the Send button and the "Thinking…" bubble can't stay stuck (DIC-1870).
    var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, CHAT_TIMEOUT_MS) : null;
    var finished = false;   // a 'done' or 'error' event arrived

    return fetch(_apiBase + '/chat', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
      signal:  ctrl ? ctrl.signal : undefined,
    }).then(function (res) {
      if (!res.ok) { var e = new Error('HTTP ' + res.status); e.status = res.status; throw e; }
      var reader  = res.body.getReader();
      var decoder = new TextDecoder();
      var buf     = '';

      function pump() {
        return reader.read().then(function (chunk) {
          if (chunk.done) {
            // Stream closed without a final event: don't leave a dead "Thinking…" bubble.
            if (!finished) {
              thinkEl.remove();
              _appendAiMsg('Map Buddy stopped before finishing. Please try again.');
            }
            return;
          }
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
              finished = true;
              thinkEl.remove();
              var responseText = evt.response_text || '';
              var aiEl = _appendAiMsg(responseText);
              // Only keep turns the server will accept when resent: an empty turn or one
              // over the history cap would make every later request fail (DIC-1870).
              if (responseText.trim()) {
                _history.push({ role: 'user',      content: userMessage.slice(0, HISTORY_MAX_CHARS) });
                _history.push({ role: 'assistant', content: responseText.slice(0, HISTORY_MAX_CHARS) });
              }
              if (evt.commands && evt.commands.length) {
                _appendActionChips(aiEl, _cmd.run(evt.commands));
              }
              if (evt.citations && evt.citations.length) {
                _appendSources(aiEl, evt.citations);
              }
            } else if (evt.type === 'error') {
              finished = true;
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
      var st = err && err.status;
      if (err && err.name === 'AbortError') {
        _appendAiMsg('That took too long, so I stopped waiting. Please try again.');
      } else if (st === 404) {
        _appendAiMsg('The AI backend isn’t connected yet. Check back soon!');
      } else if (st === 429) {
        _appendAiMsg('Map Buddy is busy right now. Please wait a moment and try again.');
      } else if (st === 413 || st === 422) {
        _appendAiMsg('That request was too long for Map Buddy. Try a shorter message.');
      } else {
        _appendAiMsg('Couldn’t reach the server. Please try again.');
      }
      console.error('[Map Buddy]', err);
    }).then(function () {
      if (timer) clearTimeout(timer);
      // The AI asked to look (look_at_map): run it now its reply is on screen; the
      // answer follows as one more turn, so the user never has to ask again.
      var look = _pendingLook;
      _pendingLook = null;
      if (look) return _lookAtMap(look);
    });
  }

  // ── Map vision (DIC-2135) ─────────────────────────────────────────────────
  // A look = capture the map canvas (pv-vision.js) → /vision/describe → show the read,
  // labelled as an AI reading of the imagery → one more chat turn that answers from it.
  function _visibleLayerLabels() {
    var ms = _cmd.buildMapState() || {};
    if (ms.layers && ms.layers.length) {
      return ms.layers.filter(function (l) { return l && l.visible; })
        .map(function (l) { return String(l.label || l.id || ''); }).filter(Boolean).slice(0, 40);
    }
    return (ms.visible_layers || []).map(String).slice(0, 40);
  }

  // Entry points the user triggers (the panel button, an accepted offer, the right-click
  // menu): one look at a time, with the input locked like a normal send.
  function _startLook(look) {
    if (_streaming) return Promise.resolve();
    var emptyState = _messagesEl.querySelector('.mb-empty-state');
    if (emptyState) emptyState.remove();
    if (look.userLabel) _appendUserMsg(look.userLabel);
    _sendBtn.disabled = true;
    _lookBtn.disabled = true;
    _streaming = true;
    var finish = function () { _sendBtn.disabled = false; _lookBtn.disabled = false; _streaming = false; };
    return _lookAtMap(look).then(finish, finish);
  }

  function _visionFailureText(status, data) {
    if (status === 429) return 'You’ve reached the limit for map looks for now. Please try again later.';
    if (data && data.degraded) return 'Map looks are paused for now because the AI limit was reached.';
    if (status === 400 && data && data.error) return 'Couldn’t analyse the map view: ' + data.error;
    return 'Couldn’t analyse the map view. Please try again in a moment.';
  }

  function _lookAtMap(look) {
    var thinkEl = _showThinking();
    _updateThinking(thinkEl, 'Looking at the map…');
    var layers = _visibleLayerLabels();
    var p = _currentParcel;
    var status = 0;
    if (!root.PV_VISION) {
      thinkEl.remove();
      _appendAiMsg('Map looks aren’t available in this viewer.');
      return Promise.resolve();
    }
    _cmd.cancelCinematic();   // Map Buddy's own fly-around; pv-vision stops the map's
    return root.PV_VISION.capture(root.PS_MAP || null).then(function (img) {
      return fetch(_apiBase + '/vision/describe', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          image:      img.data,
          media_type: img.media_type,
          view_width_ft: img.view_width_ft || null,
          question:   look.question || null,
          parcel:     p ? { pin: p.pin, site_address: p.site_address, acres: p.acres, municipality: p.municipality } : null,
          layers:     layers,
          // Overlays still loading or failing at capture (DIC-2144), so the model doesn't
          // read "no wetlands" from a layer that hadn't drawn.
          layers_incomplete: img.incomplete && img.incomplete.length ? img.incomplete.slice(0, 40) : null,
        }),
      });
    }).then(function (res) {
      status = res.status;
      return res.json().catch(function () { return null; });
    }).then(function (data) {
      thinkEl.remove();
      if (status !== 200 || !data || !data.ok || !data.description) {
        _appendAiMsg(_visionFailureText(status, data));
        return;
      }
      _appendVisionRead(data);
      var question = look.question || 'What do you see in the current map view?';
      return _streamChat(question, {
        visionRead: { description: String(data.description).slice(0, 4000), layers: data.layers || layers },
      });
    }).catch(function (err) {
      thinkEl.remove();
      _appendAiMsg(err && err.message && /map/i.test(err.message)
        ? 'Couldn’t analyse the map view: ' + err.message
        : 'Couldn’t analyse the map view. Please try again in a moment.');
      console.error('[Map Buddy] vision', err);
    });
  }

  // The read itself, labelled so it's never mistaken for a record (DIC-2135).
  function _appendVisionRead(data) {
    var el = document.createElement('div');
    el.className = 'mb-msg-ai mb-msg-vision';
    el.dataset.testid = 'mb-msg-vision';
    var lbl = document.createElement('div');
    lbl.className = 'mb-msg-ai-label';
    lbl.dataset.testid = 'mb-msg-label';
    lbl.textContent = 'AI visual read of the current map view';
    var body = document.createElement('div');
    body.className = 'mb-msg-ai-body';
    body.dataset.testid = 'mb-msg-body';
    // Same safe Markdown subset as chat replies (escaped first): the model sometimes bolds
    // its best guess, and raw "**" would show (DIC-2138).
    body.innerHTML = _renderMarkdown(String(data.description || ''));
    var meta = document.createElement('div');
    meta.className = 'mb-vision-meta';
    meta.dataset.testid = 'mb-vision-meta';
    var when = data.at ? new Date(data.at) : new Date();
    var time = isNaN(when) ? '' : when.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    var layers = (data.layers || []).join(', ');
    var incomplete = (data.layers_incomplete || []).join(', ');
    meta.textContent = (layers ? 'Layers: ' + layers : 'Base map only') +
      (incomplete ? ' (not fully loaded: ' + incomplete + ')' : '') + (time ? ' · ' + time : '') +
      ' · An interpretation of the imagery, not a survey or tax record';
    el.appendChild(lbl);
    el.appendChild(body);
    el.appendChild(meta);
    _messagesEl.appendChild(el);
    _scrollBottom();
  }

  // The AI's single offer: one button; nothing is spent unless the user taps it.
  function _appendLookOffer(question) {
    var row = document.createElement('div');
    row.className = 'mb-suggest-row mb-look-offer';
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'mb-suggest-chip mb-look-chip';
    b.textContent = 'Look at the map';
    b.addEventListener('click', function () {
      row.remove();
      _startLook({ question: question || null, userLabel: 'Look at the map' });
    });
    row.appendChild(b);
    _messagesEl.appendChild(row);
    _scrollBottom();
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

  // ── Automations palette (DIC-432) ─────────────────────────────────────────
  // A visible, one-tap list of the backend macro registry. Tapping a macro hits
  // /workflow (deterministic, no model round-trip) and runs the returned commands.
  // The catalog is fetched from /workflows, so adding a macro server-side surfaces
  // it here automatically. If the backend lacks the endpoint (e.g. not yet
  // redeployed), the palette simply doesn't render — no error.
  function _humanize(id) {
    var s = String(id || '').replace(/_/g, ' ');
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  function _loadAutomations() {
    var host = document.getElementById('mb-automations');
    if (!host) return;
    fetch(_apiBase + '/workflows')
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        var list = data && data.workflows;
        if (list && list.length) _renderAutomations(host, list);
      })
      .catch(function () { /* endpoint absent → no palette, no error */ });
  }

  function _renderAutomations(host, list) {
    var rows = list.map(function (wf) {
      var params = wf.params || {};
      var inputs = Object.keys(params).map(function (k) {
        var p = params[k] || {};
        var dv = (p.default !== undefined && p.default !== null) ? p.default : '';
        return '<label class="mb-auto-param">' + _escHtml(_humanize(k)) +
          ' <input type="number" class="mb-auto-input" data-param="' + _escHtml(k) +
          '" value="' + _escHtml(dv) + '" aria-label="' + _escHtml(_humanize(k) + ' for ' + _humanize(wf.id)) + '"></label>';
      }).join('');
      return '<div class="mb-auto-row" data-wf="' + _escHtml(wf.id) + '">' +
        '<button type="button" class="mb-auto-run" data-wf="' + _escHtml(wf.id) + '"' +
          ' title="' + _escHtml(wf.description) + '">' + _escHtml(_humanize(wf.id)) + '</button>' +
        (inputs ? '<span class="mb-auto-params">' + inputs + '</span>' : '') +
        '<span class="mb-auto-desc">' + _escHtml(wf.description) + '</span>' +
      '</div>';
    }).join('');
    host.innerHTML =
      '<button type="button" id="mb-auto-toggle" class="mb-auto-toggle"' +
        ' aria-expanded="false" aria-controls="mb-auto-body">' +
        '<span class="mb-auto-caret">▸</span><span>Automations</span></button>' +
      '<div id="mb-auto-body" class="mb-auto-body" data-testid="mb-auto-body" hidden>' + rows + '</div>';
    host.hidden = false;
    var toggle = document.getElementById('mb-auto-toggle');
    var body   = document.getElementById('mb-auto-body');
    toggle.addEventListener('click', function () {
      var open = body.hidden;
      body.hidden = !open;
      toggle.setAttribute('aria-expanded', String(open));
      toggle.querySelector('.mb-auto-caret').textContent = open ? '▾' : '▸';
    });
    [].forEach.call(host.querySelectorAll('.mb-auto-run'), function (btn) {
      btn.addEventListener('click', function () {
        _runAutomation(btn.getAttribute('data-wf'), btn.closest('.mb-auto-row'));
      });
    });
  }

  function _runAutomation(wfId, rowEl) {
    if (!_currentParcel || !_currentParcel.pin) {
      _appendAiMsg('Select a parcel first, then I can run that on it.');
      return;
    }
    var params = {};
    if (rowEl) [].forEach.call(rowEl.querySelectorAll('.mb-auto-input'), function (inp) {
      var v = parseFloat(inp.value);
      if (!isNaN(v)) params[inp.getAttribute('data-param')] = v;
    });
    fetch(_apiBase + '/workflow', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ workflow: wfId, pin: _currentParcel.pin, params: params, parcel_context: _buildContext() }),
    })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (!data || !Array.isArray(data.commands)) { _appendAiMsg('Couldn’t run that automation.'); return; }
        // No commands = the server refused (e.g. a setback out of range); its note
        // says why. Reporting "Ran …" here told the user it worked.
        if (!data.commands.length) {
          _appendAiMsg(data.note ? String(data.note) : 'Couldn’t run that automation.');
          return;
        }
        var chips = _cmd.run(data.commands);
        var el = _appendAiMsg('Ran ' + _humanize(wfId) + '.');
        if (el) _appendActionChips(el, chips);
      })
      .catch(function () { _appendAiMsg('Couldn’t reach the server for that automation.'); });
  }

  // Small secondary bubbles (measurements, search results, tour notes).
  function _appendInfoBubble(html) {
    var el = document.createElement('div');
    el.className = 'mb-msg-ai mb-msg-info';
    el.dataset.testid = 'mb-msg-info';
    el.innerHTML = '<div class="mb-msg-ai-body" data-testid="mb-msg-body">' + html + '</div>';
    _messagesEl.appendChild(el);
    _scrollBottom();
  }
  function _appendResultBubble(html) {
    var el = document.createElement('div');
    el.className = 'mb-msg-ai mb-msg-info';
    el.dataset.testid = 'mb-msg-info';
    el.innerHTML = '<div class="mb-msg-ai-body" data-testid="mb-msg-body">' + html + '</div>';
    _messagesEl.appendChild(el);
    Array.prototype.forEach.call(el.querySelectorAll('.mb-result-btn'), function (b) {
      b.addEventListener('click', function () {
        _cmd.selectResult(b.getAttribute('data-pin'));
      });
    });
    _scrollBottom();
  }
  // AI-offered next steps — tappable; clicking sends the prompt to the AI so it
  // acts. Items may be plain strings or {label, prompt}. This is how MapBuddy
  // "offers to do things" instead of requiring the user to know the commands.
  function _appendSuggestions(list) {
    var items = (list || []).map(function (s) {
      if (typeof s === 'string') return s.trim() ? { label: s, prompt: s } : null;
      if (s && s.label) return { label: s.label, prompt: s.prompt || s.label };
      return null;
    }).filter(Boolean).slice(0, 4);
    if (!items.length) return;
    var row = document.createElement('div');
    row.className = 'mb-suggest-row';
    items.forEach(function (it) {
      var b = document.createElement('button');
      b.className = 'mb-suggest-chip';
      b.textContent = _deIcon(it.label);
      b.addEventListener('click', function () { _inputEl.value = it.prompt; _send(); });
      row.appendChild(b);
    });
    _messagesEl.appendChild(row);
    _scrollBottom();
  }

  // Row of chips under an AI message summarising what it did to the map.
  function _appendActionChips(aiEl, chips) {
    if (!aiEl || !chips.length) return;
    var row = document.createElement('div');
    row.className = 'mb-action-chips';
    for (var i = 0; i < chips.length; i++) {
      var c = document.createElement('span');
      c.className = 'mb-action-chip';
      c.textContent = _deIcon(chips[i]);
      row.appendChild(c);
    }
    aiEl.appendChild(row);
    _scrollBottom();
  }

  // Render the §6.4 citations an answer cited as clickable "Sources" (DIC-522). Each
  // carries the data-cite-* envelope the viewer's Citation Renderer already listens for
  // (pv-citations.js delegated handler) → clicking resolves it against the KB and opens
  // the synchronized Sources panel with the full statute text + passage highlight. This is
  // the AI side of the 3-way sync (answer ↔ source ↔ map). Skipped when the citations
  // capability is gated off, so we never show an inert source.
  function _appendSources(aiEl, citations) {
    if (!aiEl || !citations || !citations.length) return;
    if (root.PV_CITATIONS && root.PV_CITATIONS.isEnabled && !root.PV_CITATIONS.isEnabled()) return;
    var row = document.createElement('div');
    row.className = 'mb-sources';
    var html = '<span class="mb-sources-label">Sources</span>';
    for (var i = 0; i < citations.length; i++) {
      var c = citations[i] || {};
      html += '<button type="button" class="pv-cite-trigger mb-source" data-testid="cite-trigger"' +
        ' data-cite-source="' + _escHtml(c.source_id || '') + '"' +
        ' data-cite-anchor="' + _escHtml(c.anchor || '') + '"' +
        ' data-cite-span="' + _escHtml(c.span || '') + '">' +
        _escHtml(c.source_id || c.span || 'Source') + '</button>';
    }
    row.innerHTML = html;
    aiEl.appendChild(row);
    _scrollBottom();
  }

  // ── Welcome / empty state ─────────────────────────────────────────────────
  // Context-aware starter ideas. With a parcel selected we offer parcel
  // workflows; otherwise navigation/search. Tapping one sends it as a message.
  function _starterSuggestions() {
    if (_currentParcel && _currentParcel.pin) {
      var pin = _currentParcel.pin;
      return [
        'Give me the rundown on this parcel',
        'Is ' + pin + ' at risk of flooding or wetlands?',
        'Draw a 30 ft setback and show the buildable area',
        'How big is it, with dimensions?',
      ];
    }
    return [
      'Find a parcel by owner name or address',
      'Tilt the map to 3-D with terrain shading',
      'What can you do?',
    ];
  }

  function _renderEmptyState() {
    var el = document.createElement('div');
    el.className = 'mb-empty-state';
    var hint = (_currentParcel && _currentParcel.pin)
      ? 'Parcel <strong>' + _escHtml(_currentParcel.pin) + '</strong> is selected — want me to dig in? Tap an idea, or ask anything.'
      : 'Your A.I. assistant — I can drive the map for you. Select a parcel and tap an idea below, or just ask.';
    el.innerHTML =
      '<div class="mb-empty-title">MapBuddy A.I.</div>' +
      '<div class="mb-empty-hint">' + hint + '</div>' +
      '<div class="mb-quick-btns"></div>';
    var wrap = el.querySelector('.mb-quick-btns');
    _starterSuggestions().forEach(function (text) {
      var btn = document.createElement('button');
      btn.className = 'mb-quick-btn';
      btn.textContent = text;
      btn.addEventListener('click', function () { _inputEl.value = text; _send(); });
      wrap.appendChild(btn);
    });
    _messagesEl.appendChild(el);
  }

  // Re-render the welcome screen if it's still showing — e.g. when a parcel is
  // selected, so the starter ideas become parcel-specific. No-op mid-chat.
  function _refreshEmptyState() {
    var es = _messagesEl && _messagesEl.querySelector('.mb-empty-state');
    if (es) { es.remove(); _renderEmptyState(); }
  }

  // ── Public API ────────────────────────────────────────────────────────────
  root.MapBuddy = { mount: mount, unmount: unmount };

})(window);
