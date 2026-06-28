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
    _loadAutomations();

    // Programmatic surface: lets the host (or the AI command path) drive the map
    // and inspect view state. unmount() tears this down.
    root.PV_MAP_BUDDY = {
      runCommands:   _runCommands,
      buildMapState: _buildMapState,
      send:          function (t) { if (_inputEl) { _inputEl.value = t; _send(); } },
    };

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
        '</div>' +
        '<div id="mb-automations" class="mb-automations" hidden></div>' +
        '<div id="mb-messages" class="mb-messages"' +
            ' role="log" aria-live="polite" aria-label="MapBuddy A.I. conversation"></div>' +
        '<div class="mb-input-area">' +
          '<textarea id="mb-input" class="mb-input" rows="1"' +
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

    // On mobile, always start collapsed (the unified tab bar reopens it) so the
    // viewer loads with all panels closed. Desktop restores the saved state.
    if (!_isMobile() && localStorage.getItem(STORAGE_COLLAPSED) === 'false') {
      _openPanel(true);
    } else {
      _collapsePanel(true);
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
    _streaming           = true;

    _streamChat(text).then(
      function () { _sendBtn.disabled = false; _streaming = false; },
      function () { _sendBtn.disabled = false; _streaming = false; }
    );
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
    el.textContent = text;
    _messagesEl.appendChild(el);
    _scrollBottom();
  }

  function _appendAiMsg(text) {
    var el   = document.createElement('div');
    el.className = 'mb-msg-ai';
    var lbl  = document.createElement('div');
    lbl.className   = 'mb-msg-ai-label';
    lbl.textContent = 'MapBuddy A.I.';
    var body = document.createElement('div');
    body.className   = 'mb-msg-ai-body';
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
      map_state:            _buildMapState(),
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
              var aiEl = _appendAiMsg(responseText);
              _history.push({ role: 'user',      content: userMessage   });
              _history.push({ role: 'assistant', content: responseText  });
              if (evt.commands && evt.commands.length) {
                _appendActionChips(aiEl, _runCommands(evt.commands));
              }
              if (evt.citations && evt.citations.length) {
                _appendSources(aiEl, evt.citations);
              }
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
      '<div id="mb-auto-body" class="mb-auto-body" hidden>' + rows + '</div>';
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
        var chips = _runCommands(data.commands);
        var el = _appendAiMsg('Ran ' + _humanize(wfId) + '.');
        if (el) _appendActionChips(el, chips);
      })
      .catch(function () { _appendAiMsg('Couldn’t reach the server for that automation.'); });
  }

  // ── Map command dispatch ──────────────────────────────────────────────────
  // The AI returns structured "commands"; we execute them against the live map
  // (PS_MAP), the parcel layer, the overlay registry, and the drawing/measure
  // engine (PS_MAP_CONTROL_API). Each command returns a short chip label shown
  // under the AI message so the user sees what the assistant did. A few
  // commands (measurements, search) append their own info bubble, because the
  // single-shot model can't see their result.

  function _map()  { return root.PS_MAP || null; }
  function _api()  { return root.PS_MAP_CONTROL_API || null; }
  function _turf() { return (typeof turf !== 'undefined') ? turf : null; }

  // Resolve a parcel GeoJSON feature by PIN, defaulting to the selected parcel.
  function _resolveParcel(pin) {
    var want = pin || (_currentParcel && _currentParcel.pin) || root.PS_SELECTED_PIN;
    if (!want) return null;
    // Prefer the selected parcel's full record — it carries geometry and is
    // independent of which tiles are loaded into PS_PARCEL_INDEX, so "this
    // parcel" resolves even after the user has panned/zoomed away.
    if (_currentParcel && _currentParcel.geometry &&
        (!pin || String(_currentParcel.pin) === String(want))) {
      return { type: 'Feature', properties: { pin: _currentParcel.pin }, geometry: _currentParcel.geometry };
    }
    var idx = root.PS_PARCEL_INDEX || [];
    for (var i = 0; i < idx.length; i++) {
      var pr = idx[i].properties || {};
      if (String(pr.pin || pr.PIN) === String(want)) return idx[i];
    }
    return null;
  }
  function _parcelCentroid(f) {
    var t = _turf(); if (!f || !t) return null;
    try { return t.centroid(f).geometry.coordinates; } catch (e) { return null; }
  }
  // Accept [lng,lat] | {lng,lat} | {lon,lat} → [lng,lat]
  function _coordsOf(p) {
    if (p == null) return null;
    if (Array.isArray(p) && p.length >= 2 && typeof p[0] === 'number') return [p[0], p[1]];
    if (typeof p.lng === 'number' && typeof p.lat === 'number') return [p.lng, p.lat];
    if (typeof p.lon === 'number' && typeof p.lat === 'number') return [p.lon, p.lat];
    return null;
  }
  function _ft2mi(ft) { return ft / 5280; }
  function _fmtFt(ft) { return ft >= 5280 ? (ft / 5280).toFixed(2) + ' mi' : Math.round(ft) + ' ft'; }

  // Friendly layer names → overlay-registry ids.
  var _LAYER_ALIASES = {
    flood: 'overlay-flood', floodplain: 'overlay-flood', fema: 'overlay-flood', 'flood-hazard': 'overlay-flood',
    wetlands: 'overlay-wetlands', wetland: 'overlay-wetlands', nwi: 'overlay-wetlands',
    soils: 'overlay-soils', soil: 'overlay-soils', ssurgo: 'overlay-soils',
    hillshade: 'overlay-hillshade', terrain: 'overlay-hillshade', shade: 'overlay-hillshade',
    contours: 'overlay-contours-10ft', 'contours-10ft': 'overlay-contours-10ft',
    'contours-5ft': 'overlay-contours-5ft', 'contours-2ft': 'overlay-contours-2ft',
    drains: 'county-drains', drain: 'county-drains',
    roads: 'county-roads', road: 'county-roads', 'road-centerlines': 'county-roads',
    'section-lines': 'county-section-lines', 'plss-section-lines': 'county-section-lines',
    sections: 'county-plss-sections', 'plss-sections': 'county-plss-sections',
    subdivisions: 'county-subdivisions', subdivision: 'county-subdivisions',
    'address-points': 'county-address-points', addresses: 'county-address-points',
    'parcel-points': 'county-parcel-points',
    'plss-corners': 'county-plss-corners', corners: 'county-plss-corners',
    'section-centers': 'county-section-centers',
  };
  var _LAYER_LABEL = {
    'overlay-flood': 'Flood Hazard', 'overlay-wetlands': 'Wetlands', 'overlay-soils': 'Soils',
    'overlay-hillshade': 'Hillshade', 'overlay-contours-10ft': 'Contours 10ft',
    'overlay-contours-5ft': 'Contours 5ft', 'overlay-contours-2ft': 'Contours 2ft',
    'county-drains': 'Drains', 'county-roads': 'Road centerlines',
    'county-section-lines': 'PLSS section lines', 'county-plss-sections': 'PLSS sections',
    'county-subdivisions': 'Subdivisions', 'county-address-points': 'Address points',
    'county-parcel-points': 'Parcel points', 'county-plss-corners': 'PLSS corners',
    'county-section-centers': 'Section centers',
  };
  function _resolveLayerId(id) {
    if (!id) return null;
    var key = String(id).toLowerCase().replace(/[_\s]+/g, '-');
    if (_LAYER_ALIASES[key]) return _LAYER_ALIASES[key];
    if (key.indexOf('overlay-') === 0 || key.indexOf('county-') === 0) return key;
    return null;
  }
  function _setLayer(id, visible) {
    var oid = _resolveLayerId(id);
    if (oid && oid.indexOf('county-') === 0 && root.PS_COUNTY_LAYERS && root.PS_COUNTY_LAYERS.setLayer) {
      root.PS_COUNTY_LAYERS.setLayer(oid, !!visible); return oid;
    }
    if (oid && root.PS_OVERLAY_LAYERS && root.PS_OVERLAY_LAYERS.setOverlay) {
      root.PS_OVERLAY_LAYERS.setOverlay(oid, !!visible); return oid;
    }
    var cb = document.getElementById((oid || ('overlay-' + id)) + '-toggle');
    if (cb) {
      if (cb.checked !== !!visible) { cb.checked = !!visible; cb.dispatchEvent(new Event('change')); }
      return oid || id;
    }
    return null;
  }

  // Build annotation properties (label + style) from a command payload.
  function _annProps(p, type) {
    var props = { featureType: type };
    if (p.label) props.label = p.label;
    var style = {};
    if (p.color)      { style.strokeColor = p.color; style.fontColor = p.color; }
    if (p.fill_color) { style.fillColor = p.fill_color; style.fillOpacity = 0.22; }
    if (style.strokeColor || style.fillColor) props.style = style;
    return props;
  }

  // Flashy expanding ring at a parcel centroid when the AI highlights it.
  function _pulse(pin) {
    var m = _map(), c = _parcelCentroid(_resolveParcel(pin));
    if (!m || !c || typeof maplibregl === 'undefined') return;
    try {
      var dot = document.createElement('div'); dot.className = 'mb-pulse';
      var mk = new maplibregl.Marker({ element: dot }).setLngLat(c).addTo(m);
      setTimeout(function () { try { mk.remove(); } catch (e) {} }, 1700);
    } catch (e) {}
  }

  // Camera ops within one AI reply are coalesced into a single cinematic move —
  // issuing separate flyTo/easeTo calls back-to-back makes them interrupt each
  // other (only the last survives). Each camera command records intent on _cam;
  // _flushCamera() resolves one combined animation after the batch runs.
  var _cam = null;
  function _camIntent() { _cam = _cam || {}; return _cam; }

  // Cinematic fly-around: tilt into 3-D, fly to the parcel, orbit a full 360°,
  // then settle back to a flat north-up view. Honors reduced-motion.
  var _cineRAF = null;
  function _cancelCinematic() { if (_cineRAF) { cancelAnimationFrame(_cineRAF); _cineRAF = null; } }
  function _runCinematic(m, center, zoom) {
    var reduced = false;
    try { reduced = document.documentElement.classList.contains('pv-a11y-motion') || window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) {}
    if (reduced) { m.easeTo({ center: center, zoom: zoom, pitch: 0, bearing: 0, duration: 1200, essential: true }); return; }
    _cancelCinematic();
    var ORBIT_MS = 9000, started = false;
    m.flyTo({ center: center, zoom: zoom, pitch: 60, bearing: 0, speed: 0.85, curve: 1.5, essential: true });
    function orbit() {
      if (started) return; started = true;
      var t0 = null;
      function frame(ts) {
        if (t0 === null) t0 = ts;
        var k = Math.min((ts - t0) / ORBIT_MS, 1);
        var eased = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;  // ease in-out
        m.setBearing(360 * eased);
        m.setCenter(center);
        if (k < 1) { _cineRAF = requestAnimationFrame(frame); }
        else { _cineRAF = null; m.easeTo({ bearing: 0, pitch: 0, duration: 2600, essential: true }); }
      }
      _cineRAF = requestAnimationFrame(frame);
    }
    m.once('moveend', orbit);
    setTimeout(orbit, 2600);  // fallback if moveend doesn't fire (already in place)
  }
  function _flushCamera() {
    var m = _map(), cam = _cam; _cam = null;
    if (!m || !cam) return;
    var opts = { duration: 1100, essential: true };

    // Resolve a "fit" (parcel bbox or all annotations) into center+zoom so it can
    // merge with tilt/rotate in a single easeTo.
    var bounds = null, t = _turf();
    if (cam.fitParcel !== undefined && t) {
      var f = _resolveParcel(cam.fitParcel);
      if (f) { var bb = t.bbox(f); bounds = [[bb[0], bb[1]], [bb[2], bb[3]]]; }
    } else if (cam.fitAnnotations && t) {
      var a = _api();
      if (a) { var fc = a.getAnnotations(); if (fc.features.length) { var ab = t.bbox(fc); bounds = [[ab[0], ab[1]], [ab[2], ab[3]]]; } }
    }
    if (bounds && m.cameraForBounds) {
      var cfb = m.cameraForBounds(bounds, { padding: 70, maxZoom: 18 });
      if (cfb) { opts.center = cfb.center; opts.zoom = cfb.zoom; }
    }
    if (cam.center)            opts.center  = cam.center;
    if (cam.zoom != null)      opts.zoom    = cam.zoom;
    else if (cam.zoomDelta != null) opts.zoom = m.getZoom() + cam.zoomDelta;
    if (cam.bearing != null)   opts.bearing = cam.bearing;
    if (cam.pitch != null)     opts.pitch   = Math.max(0, Math.min(85, cam.pitch));
    if (opts.center || opts.zoom != null || opts.bearing != null || opts.pitch != null) m.easeTo(opts);
  }

  // Command registry: name → fn(payload) → chip label (or null if it no-oped).
  var _CMDS = {
    // ── Camera (coalesced — see _flushCamera) ─────────────────────────────────
    fly_to_coordinates: function (p) { var c = _coordsOf(p); if (!c) return null; var k = _camIntent(); k.center = c; if (p.zoom != null) k.zoom = p.zoom; else if (k.zoom == null) k.zoom = Math.max(_map() ? _map().getZoom() : 16, 16); return '🛰️ Flew to location'; },
    fly_to_parcel: function (p) { var f = _resolveParcel(p.pin); _camIntent().fitParcel = f ? (f.properties.pin || f.properties.PIN) : (p.pin || null); return '🛰️ Zoomed to parcel' + (f ? ' ' + (f.properties.pin || f.properties.PIN) : ''); },
    fit_map_to_parcel: function () { _camIntent().fitParcel = null; return '🛰️ Fit parcel in view'; },
    cinematic_fly_to_parcel: function (p) {
      var m = _map(), f = _resolveParcel(p.pin), t = _turf();
      if (!m || !f || !t) { _camIntent().fitParcel = (p.pin || null); return '🎬 Flying to parcel'; }
      // Prefer the viewer's shared cinematic (interaction-cancel, reduced-motion).
      if (root.PS_cinematicFlyTo && f.geometry) { _cam = null; root.PS_cinematicFlyTo(f.geometry); return '🎬 Cinematic fly-around of ' + (f.properties.pin || f.properties.PIN); }
      var bb = t.bbox(f), center = _parcelCentroid(f) || [(bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2];
      var zoom = 17;
      if (m.cameraForBounds) { var cfb = m.cameraForBounds([[bb[0], bb[1]], [bb[2], bb[3]]], { padding: 140, maxZoom: 18 }); if (cfb) zoom = Math.min(cfb.zoom - 0.4, 18); }
      _cam = null;  // the cinematic sequence owns the camera
      _runCinematic(m, center, zoom);
      return '🎬 Cinematic fly-around of ' + (f.properties.pin || f.properties.PIN);
    },
    zoom_to:  function (p) { if (p.zoom == null) return null; _camIntent().zoom = p.zoom; return '🔍 Zoom ' + Math.round(p.zoom); },
    zoom_by:  function (p) { if (p.delta == null) return null; _camIntent().zoomDelta = p.delta; return p.delta >= 0 ? '🔍 Zoomed in' : '🔍 Zoomed out'; },
    set_pitch: function (p) { if (p.pitch == null) return null; _camIntent().pitch = p.pitch; return '🧭 Tilt ' + Math.round(p.pitch) + '°'; },
    set_bearing: function (p) { if (p.bearing == null) return null; _camIntent().bearing = p.bearing; return '🧭 Rotate ' + Math.round(p.bearing) + '°'; },
    reset_north: function () { var k = _camIntent(); k.bearing = 0; k.pitch = 0; return '🧭 North up'; },
    fit_to_annotations: function () { _camIntent().fitAnnotations = true; return '🖼️ Fit drawings'; },

    // ── Selection ─────────────────────────────────────────────────────────────
    select_parcel: function (p) {
      // Prefer DB id (from a backend search) — works even for parcels not in the
      // currently loaded tiles; fall back to PIN lookup within the loaded index.
      if (p.id != null && root.PS_selectParcelById) { root.PS_selectParcelById(p.id); return '📍 Selected ' + (p.pin || p.id); }
      if (p.pin && root.PS_selectParcel) { root.PS_selectParcel(p.pin); return '📍 Selected ' + p.pin; }
      return null;
    },
    select_parcel_on_map: function (p) { return _CMDS.select_parcel(p); },
    highlight_parcel:     function (p) { if (p.pin && root.PS_highlightParcel) { root.PS_highlightParcel(p.pin); _pulse(p.pin); return '✨ Highlighted ' + p.pin; } return null; },

    // ── Layers ────────────────────────────────────────────────────────────────
    set_layer_visibility: function (p) {
      var oid = _setLayer(p.layer_id, p.visible); if (!oid) return null;
      var name = _LAYER_LABEL[oid] || p.layer_id;
      return (p.visible ? '🌊 ' : '🚫 ') + name + (p.visible ? ' on' : ' off');
    },
    // Reactive cartography (DIC-515): bloom an overlay the AI is *talking about*
    // so the eye follows the words. PS_pulseOverlay ensures the layer is on,
    // pulses it, and self-gates on the "Map reactions" setting + reduced-motion
    // (Off = silent no-op). It resolves WMS rasters and PostGIS layers alike, so
    // pass the friendly name straight through (alias-map first for a tidy chip).
    pulse_layer: function (p) {
      var ref = p.layer_id;
      if (!ref || !root.PS_pulseOverlay) return null;
      var oid = _resolveLayerId(ref) || ref;
      if (!root.PS_pulseOverlay(oid)) return null;
      return '💫 ' + (_LAYER_LABEL[oid] || ref);
    },

    // ── Drawing ───────────────────────────────────────────────────────────────
    draw_point:  function (p) { var a = _api(), c = _coordsOf(p); if (!a || !c) return null; a.drawPoint(c, _annProps(p, 'point')); return '📌 Point'; },
    draw_line:   function (p) { var a = _api(), cs = (p.coordinates || []).map(_coordsOf).filter(Boolean); if (!a || cs.length < 2) return null; a.drawPolyline(cs, _annProps(p, 'polyline')); return '➖ Line'; },
    draw_polygon:function (p) { var a = _api(), cs = (p.coordinates || []).map(_coordsOf).filter(Boolean); if (!a || cs.length < 3) return null; a.drawPolygon(cs, _annProps(p, 'polygon')); return '⬠ Polygon'; },
    draw_circle: function (p) { var a = _api(), c = _coordsOf(p); if (!a || !c || !p.radius_ft) return null; a.drawCircle(c, p.radius_ft, _annProps(p, 'circle')); return '⭕ ' + _fmtFt(p.radius_ft) + ' circle'; },
    label_point: function (p) { var a = _api(), c = _coordsOf(p); if (!a || !c || !p.text) return null; a.addLabel(c, p.text); return '🏷️ Label'; },
    label_parcel_centroid: function (p) { var a = _api(), c = _parcelCentroid(_resolveParcel(p.pin)); if (!a || !c || !p.text) return null; a.addLabel(c, p.text); return '🏷️ Labeled parcel'; },
    draw_parcel_buffer: function (p) {
      var a = _api(), t = _turf(), f = _resolveParcel(p.pin);
      if (!a || !t || !f || !p.distance_ft) return null;
      var buffered;
      try { buffered = t.buffer(f, _ft2mi(p.distance_ft) * (p.inward ? -1 : 1), { units: 'miles' }); }
      catch (e) { return null; }
      if (!buffered || !buffered.geometry) return null;
      var ring = buffered.geometry.coordinates[0].map(function (c) { return [c[0], c[1]]; });
      a.drawPolygon(ring, {
        featureType: 'polygon', labelAuto: true,
        label: p.label || (_fmtFt(p.distance_ft) + (p.inward ? ' setback' : ' buffer')),
        style: { strokeColor: '#d97706', fillColor: '#f59e0b', fillOpacity: 0.15 },
      });
      return '⭕ ' + _fmtFt(p.distance_ft) + (p.inward ? ' setback' : ' buffer');
    },
    place_structure_in_parcel: function (p) {
      var a = _api(), c = _parcelCentroid(_resolveParcel(p.pin));
      if (!a || !c || !p.width_ft || !p.depth_ft) return null;
      a.placeStructure({ center: c, width: p.width_ft, depth: p.depth_ft, units: 'feet', rotationDeg: p.rotation_deg || 0, label: p.label || 'Structure' });
      return '🏠 ' + p.width_ft + '×' + p.depth_ft + ' ft footprint';
    },
    clear_annotations: function () { var a = _api(); if (a) a.clearAnnotations(); return '🧹 Cleared drawings'; },

    // ── Built-in map tools (the viewer's own tooling) ─────────────────────────
    set_parcel_labels: function (p) {
      var L = root.PS_PARCEL_LABELS; if (!L) return null;
      var visible = p.visible !== false;
      if (p.field && L.setField) L.setField(p.field);
      if (p.size && L.setSize) L.setSize(p.size);
      if (visible) { if (L.activate) L.activate(); } else { if (L.deactivate) L.deactivate(); return '🏷️ Labels off'; }
      var nice = { owner:'Owner', pin:'PIN', address:'Address', av:'Assessed value', sev:'SEV',
                   tv:'Taxable value', tmv:'Market value', tmv_acre:'$/acre', zoning:'Zoning', class:'Class' };
      return '🏷️ ' + (nice[p.field] || 'Parcel') + ' labels on';
    },
    dimension_parcel: function (p) {
      var f = _resolveParcel(p.pin);
      if (!f || !root.PS_MEASURE_TOOL || !root.PS_MEASURE_TOOL.dimensionParcel) return null;
      root.PS_MEASURE_TOOL.dimensionParcel(f);
      return '📐 Dimensioned the parcel';
    },
    activate_draw_tool: function (p) {
      var D = root.PS_DRAWING_TOOLS; if (!D || !p.tool || !D.setActiveDrawTool) return null;
      if (D.setStyle && (p.color || p.fill_color)) {
        var st = {}; if (p.color) st.strokeColor = p.color; if (p.fill_color) st.fillColor = p.fill_color;
        D.setStyle(st);
      }
      D.setActiveDrawTool(p.tool);
      return '✏️ ' + p.tool + ' tool — draw on the map';
    },
    undo: function () { if (root.PS_UNDO_REDO && root.PS_UNDO_REDO.undo) { root.PS_UNDO_REDO.undo(); return '↩️ Undo'; } return null; },
    redo: function () { if (root.PS_UNDO_REDO && root.PS_UNDO_REDO.redo) { root.PS_UNDO_REDO.redo(); return '↪️ Redo'; } return null; },

    // Open one of the viewer's own tools/windows (Parcel Packet, Compare, Street
    // View, tax/assessment explainers, print, share, bookmark, settings, …).
    open_tool: function (p) {
      var T = root.PV_TOOLS; if (!T || !T.open) return null;
      var name = String(p.tool || p.name || '').toLowerCase().replace(/_/g, '-').trim();
      var ALIAS = {
        'parcel-packet': 'packet', 'report': 'packet',
        'compare-parcels': 'compare', 'street-view': 'streetview',
        'tax-description': 'tax', 'taxes': 'tax', 'assessment': 'assess',
        'bookmarks': 'bookmark',
      };
      var canon = ALIAS[name] || name;
      T.open(canon);
      var LABEL = { packet: 'Parcel Packet', compare: 'Compare Parcels', streetview: 'Street View',
        tax: 'Tax Explainer', assess: 'Assessment Explainer', print: 'Print', share: 'Share',
        bookmark: 'Bookmarks', 'data-request': 'Data Request', 'report-error': 'Report Error',
        help: 'Help', 'whats-new': "What's New", about: 'About', settings: 'Settings' };
      return '🪟 Opened ' + (LABEL[canon] || canon);
    },

    // ── Compare (DIC-589): open the side-by-side table for named parcels ──────
    compare_parcels: function (p) {
      if (!root.PV_COMPARE || !root.PV_COMPARE.open) return null;
      var items = [].concat(p.ids || [], p.pins || []).filter(function (x) { return x != null && x !== ''; });
      if (items.length < 2) return null;
      root.PV_COMPARE.open(items.slice(0, 5));
      return '📊 Compared ' + Math.min(items.length, 5) + ' parcels';
    },

    // ── Neighborhood / Area Profile (DIC-588): open the dashboard + AI character read ──
    describe_neighborhood: function (p) {
      if (!root.PV_PROFILE || !root.PV_PROFILE.open) return null;
      var geo = p.geography && String(p.geography).toLowerCase();
      if (geo && ['subdivision', 'section', 'township', 'school'].indexOf(geo) >= 0) {
        var name = p.name != null ? String(p.name) : null;
        if (!name) return null;
        root.PV_PROFILE.open({ mode: geo, geoName: name });
        return '🏘️ Profiling ' + name;
      }
      var opts = { mode: 'buffer' };
      if (p.id != null && !isNaN(parseInt(p.id, 10))) opts.parcelId = parseInt(p.id, 10);
      if (p.distance_ft != null && !isNaN(Number(p.distance_ft))) opts.distanceFt = Number(p.distance_ft);
      root.PV_PROFILE.open(opts);   // parcelId omitted → defaults to the selected parcel
      var d = opts.distanceFt || 1320;
      return '🏘️ Neighborhood profile (' + (d >= 5280 ? (d / 5280) + ' mi' : d + ' ft') + ')';
    },

    // ── Interface / appearance ────────────────────────────────────────────────
    set_theme: function (p) {
      var dark = p.dark != null ? !!p.dark : /dark|night/i.test(p.mode || p.theme || '');
      if (root.PV_THEME && root.PV_THEME.set) { root.PV_THEME.set(dark); return dark ? '🌙 Dark mode' : '☀️ Light mode'; }
      return null;
    },
    set_basemap: function (p) {
      var b = String(p.basemap || '').toLowerCase();
      if (['light', 'dark', 'aerial'].indexOf(b) < 0) return null;
      if (root.PV_PREFS && root.PV_PREFS.setBasemap) { root.PV_PREFS.setBasemap(b); return '🗺️ ' + b.charAt(0).toUpperCase() + b.slice(1) + ' basemap'; }
      return null;
    },
    set_base_layer: function (p) {
      var L = root.PS_MAP_PANEL && root.PS_MAP_PANEL.layers; if (!L) return null;
      var did = [];
      if (typeof p.aerial === 'boolean' && L.setAerial) { L.setAerial(p.aerial); did.push('aerial ' + (p.aerial ? 'on' : 'off')); }
      if (typeof p.parcels === 'boolean' && L.setZoning) { L.setZoning(p.parcels); did.push('parcels ' + (p.parcels ? 'on' : 'off')); }
      return did.length ? '🗺️ ' + did.join(', ') : null;
    },
    set_accessibility: function (p) {
      var A = root.PV_A11Y; if (!A) return null;
      if (p.max != null && A.setMax) { A.setMax(!!p.max); return p.max ? '♿ Max accessibility on' : '♿ Accessibility reset'; }
      var did = [];
      if (p.large_text != null && A.setTextScale) { A.setTextScale(p.large_text ? 1.3 : 1); did.push('text ' + (p.large_text ? 'large' : 'normal')); }
      if (p.text_scale != null && A.setTextScale) { A.setTextScale(p.text_scale); did.push('text ' + p.text_scale + '×'); }
      if (p.high_contrast != null && A.setFlag) { A.setFlag('contrast', !!p.high_contrast); did.push('contrast ' + (p.high_contrast ? 'on' : 'off')); }
      if (p.readable_font != null && A.setFlag) { A.setFlag('font', !!p.readable_font); did.push('readable font ' + (p.readable_font ? 'on' : 'off')); }
      if (p.reduce_motion != null && A.setFlag) { A.setFlag('motion', !!p.reduce_motion); did.push('reduced motion ' + (p.reduce_motion ? 'on' : 'off')); }
      if (p.reduce_transparency != null && A.setFlag) { A.setFlag('solid', !!p.reduce_transparency); did.push('solid panels ' + (p.reduce_transparency ? 'on' : 'off')); }
      return did.length ? '♿ ' + did.join(', ') : null;
    },
    set_panel_transparency: function (p) {
      if (root.PV_GLASS && p.alpha != null) { var a = root.PV_GLASS.set(p.alpha); return '🪟 Panels ' + Math.round(a * 100) + '% opaque'; }
      return null;
    },
    open_panel: function (p) {
      var which = String(p.panel || '').toLowerCase();
      if (/buddy|assistant|chat/.test(which)) return '💬 MapBuddy';
      if (root.PS_MAP_PANEL) {
        if (p.tab && root.PS_MAP_PANEL.setTab) root.PS_MAP_PANEL.setTab(p.tab);
        var el = document.getElementById('map-control-panel'); if (el) el.hidden = false;
        if (root.PV_MOBILE_TABS && root.PV_MOBILE_TABS.refresh) root.PV_MOBILE_TABS.refresh();
        return '📋 Opened ' + (p.tab || 'controls') + ' panel';
      }
      return null;
    },
    set_area_units: function (p) {
      var u = /sq|ft|feet/i.test(p.units || '') ? 'sqft' : 'acres';
      if (root.PV_PREFS && root.PV_PREFS.setAreaUnits) { root.PV_PREFS.setAreaUnits(u); return '📏 ' + (u === 'sqft' ? 'Square feet' : 'Acres'); }
      return null;
    },
    set_coordinate_format: function (p) {
      var m = { dd: 'dd', decimal: 'dd', dms: 'dms', spc: 'spc', 'state plane': 'spc', stateplane: 'spc' };
      var fmt = m[String(p.format || '').toLowerCase()];
      if (fmt && root.PV_COORDS && root.PV_COORDS.setFormat) { root.PV_COORDS.setFormat(fmt); return '🧭 ' + fmt.toUpperCase() + ' coordinates'; }
      return null;
    },
    bookmark_current: function () {
      var p = _currentParcel;
      if (p && p.id != null && root.PV_BOOKMARKS && root.PV_BOOKMARKS.add) { root.PV_BOOKMARKS.add(p); return '⭐ Bookmarked ' + (p.pin || ''); }
      return null;
    },

    // ── Measurement (append an info bubble — model can't see the result) ───────
    measure_parcel: function (p) {
      var a = _api(), f = _resolveParcel(p.pin); if (!a || !f) return null;
      var pin = f.properties.pin || f.properties.PIN, info = a.quickParcelInfo(pin);
      _appendInfoBubble('<strong>Parcel ' + _escHtml(pin) + '</strong><br>' +
        info.acres + ' ac · ' + info.sqft.toLocaleString() + ' ft²<br>' +
        'Perimeter ' + info.perimFt.toLocaleString() + ' ft · ~' + info.estDimLong + '×' + info.estDimShort + ' ft');
      return '📐 Measured ' + pin;
    },
    measure_area: function (p) {
      var a = _api(), cs = (p.coordinates || []).map(_coordsOf).filter(Boolean);
      if (!a || cs.length < 3) return null;
      var r = a.measureArea(cs);
      _appendInfoBubble('<strong>Area</strong><br>' + r.acres + ' ac · ' + r.sqft.toLocaleString() + ' ft²<br>Perimeter ' + r.perimFt.toLocaleString() + ' ft');
      return '📐 Measured area';
    },
    measure_distance: function (p) {
      var a = _api(), cs = (p.coordinates || []).map(_coordsOf).filter(Boolean);
      if (!a || cs.length < 2) return null;
      var r = a.measureDistance(cs);
      _appendInfoBubble('<strong>Distance</strong><br>' + r.totalFt.toLocaleString() + ' ft (' + (r.totalFt / 5280).toFixed(2) + ' mi)');
      return '📐 Measured distance';
    },

    // ── Search (resolve client-side against the loaded parcel index) ──────────
    search_parcels: function (p) {
      var q = (p.query || '').toLowerCase().trim(); if (!q) return null;
      var idx = root.PS_PARCEL_INDEX || [], hits = [];
      for (var i = 0; i < idx.length && hits.length < 25; i++) {
        var pr = idx[i].properties || {};
        var hay = [pr.pin || pr.PIN, pr.owner_name || pr.OWNER_NAME, pr.site_address || pr.SITE_ADDRESS].join(' ').toLowerCase();
        if (hay.indexOf(q) !== -1) hits.push(idx[i]);
      }
      if (!hits.length) { _appendInfoBubble('No parcels matched “' + _escHtml(p.query) + '”.'); return 'No matches'; }
      if (hits.length === 1) {
        var pin = hits[0].properties.pin || hits[0].properties.PIN;
        if (root.PS_selectParcel) root.PS_selectParcel(pin);
        _CMDS.cinematic_fly_to_parcel({ pin: pin });
        return '🔎 Found ' + pin;
      }
      var html = '<strong>' + hits.length + ' matches</strong> for “' + _escHtml(p.query) + '”:<ul class="mb-result-list">';
      for (var j = 0; j < hits.length; j++) {
        var pr2 = hits[j].properties, pin2 = pr2.pin || pr2.PIN;
        html += '<li><button class="mb-result-btn" data-pin="' + _escHtml(pin2) + '">' +
          _escHtml(pin2) + (pr2.owner_name ? ' — ' + _escHtml(pr2.owner_name) : '') + '</button></li>';
      }
      _appendResultBubble(html + '</ul>');
      return '🔎 ' + hits.length + ' matches';
    },

    // ── Proactive offers — render tappable "next step" suggestions ────────────
    suggest_actions: function (p) { _appendSuggestions(p.suggestions || p.actions || []); return null; },

    // ── Showcase: a guided fly-through tour ───────────────────────────────────
    map_tour: function (p) {
      var stops = p.stops || [], m = _map(); if (!m || !stops.length) return null;
      var i = 0;
      (function step() {
        if (i >= stops.length) return;
        var s = stops[i++], c = _coordsOf(s) || _parcelCentroid(_resolveParcel(s.pin));
        if (c) m.flyTo({ center: c, zoom: s.zoom || 16, speed: 0.8, curve: 1.4, essential: true });
        if (s.note) _appendInfoBubble(_escHtml(s.note));
        setTimeout(step, 2600);
      })();
      return '🎬 Tour · ' + stops.length + ' stops';
    },
  };

  function _runCommands(cmds) {
    var chips = [];
    _cam = null;
    _cancelCinematic();  // a new request stops any in-flight fly-around
    for (var i = 0; i < cmds.length; i++) {
      var cmd = cmds[i]; if (!cmd || !cmd.type) continue;
      var fn = _CMDS[cmd.type];
      if (!fn) { console.warn('[Map Buddy] unknown command:', cmd.type); continue; }
      try { var label = fn(cmd.payload || {}); if (label) chips.push(label); }
      catch (e) { console.warn('[Map Buddy] command error', cmd, e); }
    }
    _flushCamera();
    return chips;
  }

  // Snapshot of the live map view + visible overlays, sent as context so the AI
  // knows where the user is looking and can pass real coordinates back.
  function _buildMapState() {
    var m = _map(); if (!m) return null;
    var c = m.getCenter(), layers = [];
    try {
      if (root.PS_OVERLAY_LAYERS && root.PS_OVERLAY_LAYERS.getState) {
        var st = root.PS_OVERLAY_LAYERS.getState() || {};
        for (var id in st) { if (st[id]) layers.push(_LAYER_LABEL[id] || id); }
      }
      if (root.PS_COUNTY_LAYERS && root.PS_COUNTY_LAYERS.getState) {
        var cst = root.PS_COUNTY_LAYERS.getState() || {};
        for (var cid in cst) { if (cst[cid]) layers.push(_LAYER_LABEL[cid] || cid); }
      }
    } catch (e) {}
    // Full live layer state (DIC-327): every layer + visibility + field schema,
    // so the AI knows what's on the map and what each layer contains. Falls back
    // to the legacy visible-overlay labels if the registry isn't loaded.
    var registry = null;
    try {
      if (root.PS_LAYER_REGISTRY && root.PS_LAYER_REGISTRY.snapshot) {
        registry = root.PS_LAYER_REGISTRY.snapshot();
      }
    } catch (e) {}
    return {
      center:  [ +c.lng.toFixed(6), +c.lat.toFixed(6) ],
      zoom:    +m.getZoom().toFixed(2),
      bearing: Math.round(m.getBearing()),
      pitch:   Math.round(m.getPitch()),
      visible_layers: layers,
      layers:  registry,
    };
  }

  // Small secondary bubbles (measurements, search results, tour notes).
  function _appendInfoBubble(html) {
    var el = document.createElement('div');
    el.className = 'mb-msg-ai mb-msg-info';
    el.innerHTML = '<div class="mb-msg-ai-body">' + html + '</div>';
    _messagesEl.appendChild(el);
    _scrollBottom();
  }
  function _appendResultBubble(html) {
    var el = document.createElement('div');
    el.className = 'mb-msg-ai mb-msg-info';
    el.innerHTML = '<div class="mb-msg-ai-body">' + html + '</div>';
    _messagesEl.appendChild(el);
    Array.prototype.forEach.call(el.querySelectorAll('.mb-result-btn'), function (b) {
      b.addEventListener('click', function () {
        var pin = b.getAttribute('data-pin');
        if (root.PS_selectParcel) root.PS_selectParcel(pin);
        _CMDS.cinematic_fly_to_parcel({ pin: pin });
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
      html += '<button type="button" class="pv-cite-trigger mb-source"' +
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
