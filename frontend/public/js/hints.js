/**
 * hints.js — onboarding & contextual hint pills + "show me where" teaching (DIC-529).
 *
 * A rail of ACTIONABLE pills at the bottom-center of the map that helps the
 * public learn the viewer and discover capabilities. Each pill is a tip AND a
 * one-tap action. Pills that map to a real control also offer a deliberate
 * second tap — "show me where" — that spotlights the actual button (dim the
 * rest + ring it + a coachmark explaining what it's for and where it lives), so
 * hints teach the path, not just the outcome.
 *
 * Client-side rule engine over state we already track (selection, zoom, aerial)
 * — instant, deterministic, no backend, no per-frame work (DIC-528).
 *
 * Persistence (localStorage): pv-hints-enabled (master on/off; default ON,
 * dismiss → off across loads) · pv-hints-seen (acted-on/learned hints retire).
 * Settings drives this via window.PS_HINTS { isEnabled, setEnabled, reset }.
 */
(function () {
  'use strict';

  var LS_ENABLED = 'pv-hints-enabled';
  var LS_SEEN    = 'pv-hints-seen';

  function _enabled() { try { return localStorage.getItem(LS_ENABLED) !== '0'; } catch (_) { return true; } }
  function _setEnabled(on) { try { localStorage.setItem(LS_ENABLED, on ? '1' : '0'); } catch (_) {} _render(true); }
  function _seen() { try { return JSON.parse(localStorage.getItem(LS_SEEN) || '[]') || []; } catch (_) { return []; } }
  function _markSeen(id) {
    if (!id) return;
    var s = _seen();
    if (s.indexOf(id) === -1) { s.push(id); try { localStorage.setItem(LS_SEEN, JSON.stringify(s)); } catch (_) {} }
  }
  function _isSeen(id) { return _seen().indexOf(id) !== -1; }
  function _reset() { try { localStorage.removeItem(LS_SEEN); localStorage.setItem(LS_ENABLED, '1'); } catch (_) {} _render(true); }

  function _map() { return window.PS_MAP || null; }
  function _selected() { return (window.PS_STATE && window.PS_STATE.parcel) || null; }
  function _aerialOn() { var el = document.getElementById('toggle-aerial'); return !!(el && el.checked); }

  // ── Actions ──────────────────────────────────────────────────────────────
  function _openSearch() {
    var btn = document.getElementById('pv-search-btn'); if (btn) btn.click();
    setTimeout(function () { var i = document.getElementById('parcel-search-input'); if (i) i.focus(); }, 60);
  }
  function _askBuddy() {
    try { if (window.PV_MAP_BUDDY && PV_MAP_BUDDY.toggle && !(PV_MAP_BUDDY.isOpen && PV_MAP_BUDDY.isOpen())) PV_MAP_BUDDY.toggle(); } catch (_) {}
  }
  function _tour() { var p = _selected(); if (p && p.geometry && window.PS_cinematicFlyTo) { try { PS_cinematicFlyTo(p.geometry); } catch (_) {} } }
  function _tool(name) { try { if (window.PV_TOOLS && PV_TOOLS.open) PV_TOOLS.open(name); } catch (_) {} }
  function _showAerial() { var el = document.getElementById('toggle-aerial'); if (el && !el.checked) { el.checked = true; el.dispatchEvent(new Event('change', { bubbles: true })); } }
  function _zoomIn() { var m = _map(); if (m) m.easeTo({ zoom: Math.max(m.getZoom() + 2, 14), duration: 800 }); }

  // Ensure the Map Controls panel is open on the given tab (for layer/tool hints).
  function _openPanel(tab) {
    var reopen = document.getElementById('mcp-reopen-tab');
    if (reopen && !reopen.hidden) reopen.click();
    try { if (window.PS_MAP_PANEL && PS_MAP_PANEL.setTab) PS_MAP_PANEL.setTab(tab); } catch (_) {}
  }

  // ── Rule set → ordered candidate hints for the current context ─────────────
  // teach: { target (CSS sel of the real control), title, body, reveal? } — drives
  // the "show me where" spotlight. Omit for pure-instruction hints.
  function _candidates() {
    var m = _map(); if (!m) return [];
    var z = m.getZoom();
    var sel = _selected();
    var out = [];
    if (sel) {
      if (window.PV_TOOLS) out.push({ id: 'packet', icon: 'ti-file-description', label: 'Parcel packet', act: function () { _tool('packet'); },
        teach: { target: '.pv-ptool[data-ptool="packet"]', title: 'Parcel packet', body: 'The full property report — owner, history, maps, taxes. Open it from the parcel card.' } });
      if (window.PS_cinematicFlyTo && sel.geometry) out.push({ id: 'tour', icon: 'ti-drone', label: 'Tour this parcel', act: _tour });
      if (window.PV_TOOLS) out.push({ id: 'tax', icon: 'ti-receipt', label: 'Tax breakdown', act: function () { _tool('tax'); },
        teach: { target: '.pv-info-btn[data-info="tax"]', title: 'Tax description', body: 'A plain-language breakdown of this parcel’s tax description. The "i" button on the card opens it.' } });
      if (window.PV_TOOLS) out.push({ id: 'compare', icon: 'ti-arrows-diff', label: 'Compare parcels', act: function () { _tool('compare'); },
        teach: { target: '.pv-ptool[data-ptool="compare"]', title: 'Compare', body: 'Put two parcels side by side. Open it from the parcel card.' } });
      if (window.PV_TOOLS) out.push({ id: 'streetview', icon: 'ti-streetview', label: 'Street view', act: function () { _tool('streetview'); },
        teach: { target: '.pv-ptool[data-ptool="streetview"]', title: 'Street view', body: 'Jump to street-level imagery at this parcel. Open it from the parcel card.' } });
      if (window.PV_TOOLS) out.push({ id: 'assess', icon: 'ti-home-dollar', label: 'How assessment works', act: function () { _tool('assess'); },
        teach: { target: '.pv-info-btn[data-info="assess"]', title: 'Assessment', body: 'What the assessed and taxable values mean. The "i" next to values explains it.' } });
      if (z >= 15 && !_aerialOn()) out.push({ id: 'aerial', icon: 'ti-satellite', label: 'See from above', act: _showAerial,
        teach: { target: '#toggle-aerial', title: 'Aerial imagery', body: 'See the land as it really looks — helpful for buildings, water, and tree cover. Toggle it in the Layers panel.', reveal: function () { _openPanel('layers'); } } });
    } else {
      if (z < 12) out.push({ id: 'zoom-in', icon: 'ti-zoom-in', label: 'Zoom in to see parcels', act: _zoomIn });
      out.push({ id: 'click-parcel', icon: 'ti-click', label: 'Click any parcel', act: function () {}, sticky: true });
      out.push({ id: 'search', icon: 'ti-search', label: 'Search an address', act: _openSearch,
        teach: { target: '#pv-search-btn', title: 'Search', body: 'Find any parcel by address, owner, or parcel number. The search box is at the top.' } });
      if (window.PV_MAP_BUDDY) out.push({ id: 'ask-buddy', icon: 'ti-message-chatbot', label: 'Ask Map Buddy', act: _askBuddy,
        teach: { target: '#mb-tab-btn', title: 'Map Buddy', body: 'Ask questions in plain language — "is this in a floodplain?" Open it from the tab on the right.' } });
      out.push({ id: 'layers', icon: 'ti-stack-2', label: 'Map layers & overlays', act: function () { _openPanel('layers'); },
        teach: { target: '#mcp-header', title: 'Layers', body: 'Turn on wetlands, flood, soils, aerial and county layers here, then click the map to inspect them.', reveal: function () { _openPanel('layers'); } } });
      out.push({ id: 'measure', icon: 'ti-ruler-2', label: 'Measure & draw', act: function () { _openPanel('measure'); },
        teach: { target: '#mcp-header', title: 'Measure & draw', body: 'Measure distances and areas, or sketch on the map. Find them in the Map Controls tabs.', reveal: function () { _openPanel('measure'); } } });
    }
    return out;
  }

  // ── "Show me where" spotlight + coachmark ──────────────────────────────────
  var _coach = null;
  function _closeCoach() { if (_coach) { try { _coach.remove(); } catch (_) {} _coach = null; document.removeEventListener('keydown', _coachKey); } }
  function _coachKey(e) { if (e.key === 'Escape') _closeCoach(); }

  function _spotlight(target, teach, onDone) {
    if (!target) { onDone && onDone(); return; }
    _closeCoach();
    // The real control may be scrolled out of view (e.g. a tool button low in the
    // parcel card) — bring it on-screen first, then spotlight where it lands.
    try { target.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch (_) {}
    setTimeout(function () { _buildSpotlight(target, teach, onDone); }, 70);
  }

  function _buildSpotlight(target, teach, onDone) {
    var r = target.getBoundingClientRect();
    var pad = 6;

    var wrap = document.createElement('div');
    wrap.className = 'pv-coach-wrap';
    wrap.addEventListener('click', function (e) { if (e.target === wrap) { _closeCoach(); onDone && onDone(); } });

    var hole = document.createElement('div');
    hole.className = 'pv-coach-hole';
    hole.style.left = (r.left - pad) + 'px';
    hole.style.top = (r.top - pad) + 'px';
    hole.style.width = (r.width + 2 * pad) + 'px';
    hole.style.height = (r.height + 2 * pad) + 'px';
    wrap.appendChild(hole);

    var call = document.createElement('div');
    call.className = 'pv-coach-call';
    call.setAttribute('role', 'dialog');
    call.setAttribute('aria-label', teach.title || 'Hint');
    var h = document.createElement('div'); h.className = 'pv-coach-title'; h.textContent = teach.title || '';
    var b = document.createElement('div'); b.className = 'pv-coach-body'; b.textContent = teach.body || '';
    var row = document.createElement('div'); row.className = 'pv-coach-row';
    var act = document.createElement('button'); act.type = 'button'; act.className = 'pv-coach-act'; act.textContent = 'Open it now';
    var got = document.createElement('button'); got.type = 'button'; got.className = 'pv-coach-got'; got.textContent = 'Got it';
    act.addEventListener('click', function () { _closeCoach(); onDone && onDone(true); });
    got.addEventListener('click', function () { _closeCoach(); onDone && onDone(false); });
    row.appendChild(act); row.appendChild(got);
    call.appendChild(h); call.appendChild(b); call.appendChild(row);
    wrap.appendChild(call);
    document.body.appendChild(wrap);
    _coach = wrap;

    // Place the callout where it fits: right → left → below → above the control;
    // on narrow screens, pin near the bottom-center.
    var cw = 230, gap = 12, vw = window.innerWidth, vh = window.innerHeight;
    call.style.width = cw + 'px';
    var callH = call.offsetHeight || 150;
    var clampY = function (y) { return Math.max(12, Math.min(vh - callH - 12, y)); };
    var clampX = function (x) { return Math.max(12, Math.min(vw - cw - 12, x)); };
    if (vw < 640) {
      call.style.left = '50%'; call.style.transform = 'translateX(-50%)';
      call.style.bottom = '16px'; call.style.width = 'auto'; call.style.maxWidth = 'calc(100vw - 24px)';
    } else if (r.right + cw + gap < vw) {
      call.style.left = (r.right + gap) + 'px'; call.style.top = clampY(r.top - 8) + 'px';
    } else if (r.left - cw - gap > 0) {
      call.style.left = (r.left - cw - gap) + 'px'; call.style.top = clampY(r.top - 8) + 'px';
    } else if (r.bottom + callH + gap < vh) {
      call.style.left = clampX(r.left) + 'px'; call.style.top = (r.bottom + gap) + 'px';
    } else {
      call.style.left = clampX(r.left) + 'px'; call.style.top = clampY(r.top - callH - gap) + 'px';
    }
    document.addEventListener('keydown', _coachKey);
    setTimeout(function () { try { act.focus(); } catch (_) {} }, 0);
  }

  // Second-tap teach: reveal the control if needed, spotlight it, retire the hint.
  function _teach(hint) {
    var t = hint.teach; if (!t) return;
    try { if (t.reveal) t.reveal(); } catch (_) {}
    setTimeout(function () {
      var el = document.querySelector(t.target);
      _spotlight(el, t, function (doIt) {
        if (doIt) { try { hint.act(); } catch (_) {} }
        _markSeen(hint.id);   // they've learned where it lives — retire it
        _render(true);
      });
    }, t.reveal ? 120 : 0);
  }

  // ── Rail ────────────────────────────────────────────────────────────────────
  var _rail = null, _lastKey = null;

  function _ensureRail() {
    if (_rail) return _rail;
    var host = document.getElementById('map');
    if (!host) return null;
    _rail = document.createElement('div');
    _rail.id = 'pv-hints';
    _rail.className = 'pv-hints';
    _rail.setAttribute('role', 'group');
    _rail.setAttribute('aria-label', 'Hints');
    _rail.setAttribute('aria-live', 'polite');
    host.appendChild(_rail);
    return _rail;
  }

  function _render(force) {
    var rail = _ensureRail();
    if (!rail) return;
    var shown = _enabled()
      ? _candidates().filter(function (h) { return !_isSeen(h.id); }).slice(0, 3)
      : [];
    var key = (_enabled() ? '1' : '0') + ':' + shown.map(function (h) { return h.id; }).join(',');
    if (!force && key === _lastKey) return;
    _lastKey = key;

    rail.textContent = '';
    if (!shown.length) { rail.hidden = true; return; }
    rail.hidden = false;

    shown.forEach(function (h, i) {
      var pill = document.createElement('span');
      pill.className = 'pv-hint-pill' + (i === 0 ? ' pv-hint-pill--primary' : '');

      var main = document.createElement('button');
      main.type = 'button';
      main.className = 'pv-hint-main';
      var ic = document.createElement('i'); ic.className = 'ti ' + h.icon; ic.setAttribute('aria-hidden', 'true');
      var sp = document.createElement('span'); sp.textContent = h.label;
      main.appendChild(ic); main.appendChild(sp);
      main.addEventListener('click', function () {
        try { h.act(); } catch (_) {}
        if (!h.sticky) _markSeen(h.id);
        _render(true);
      });
      pill.appendChild(main);

      if (h.teach) {
        var where = document.createElement('button');
        where.type = 'button';
        where.className = 'pv-hint-where';
        where.setAttribute('aria-label', 'Show me where ' + h.label + ' is');
        where.title = 'Show me where';
        where.textContent = '?';   // literal glyph — clear "clickable help", no icon-font dependency
        where.addEventListener('click', function (e) { e.stopPropagation(); _teach(h); });
        pill.appendChild(where);
      }
      rail.appendChild(pill);
    });

    var x = document.createElement('button');
    x.type = 'button';
    x.className = 'pv-hint-dismiss';
    x.setAttribute('aria-label', 'Hide hints');
    x.textContent = '×';   // literal × — no icon-font dependency (the 'ti' font may not load;
                                // same reason the '?' help glyph above is a literal, not an <i>)
    x.addEventListener('click', function () { _setEnabled(false); });
    rail.appendChild(x);
  }

  // ── Wiring ──────────────────────────────────────────────────────────────────
  var _moveTimer = null;
  function _scheduleRender() { clearTimeout(_moveTimer); _moveTimer = setTimeout(function () { _render(false); }, 120); }

  function _init() {
    var m = _map();
    if (!m) { setTimeout(_init, 300); return; }
    _render(true);
    m.on('moveend', _scheduleRender);
    document.addEventListener('ps:layers-changed', function () { _render(false); });
    document.addEventListener('ps:selection-changed', function () { _render(false); });
    var prev = window.PS_onParcelSelect;
    window.PS_onParcelSelect = function (parcel) {
      try { if (prev) prev(parcel); } catch (_) {}
      if (parcel) _markSeen('click-parcel');
      _render(false);
    };
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', _init);
  else _init();

  window.PS_HINTS = { isEnabled: _enabled, setEnabled: _setEnabled, reset: _reset };
}());
