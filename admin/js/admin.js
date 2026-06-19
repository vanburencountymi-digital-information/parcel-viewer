/**
 * admin.js — Parcel Viewer Admin Console shell (DIC-467).
 *
 * Config-as-data, read side. Today it reads the live county manifest
 * (window.COUNTY from county-config.js); a runtime /config API (DIC-465) will
 * replace that source, and the writable store (DIC-464, blocked by DIC-400)
 * makes the modules editable. The module registry below is the extension point:
 * each settings area registers a {id, label, icon, render} entry.
 */
(function () {
  'use strict';

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function el(html) { var d = document.createElement('div'); d.innerHTML = html.trim(); return d.firstChild; }
  function pageHead(title, sub) {
    return '<div class="ac-page-head"><h1 class="ac-page-title">' + esc(title) + '</h1>' +
      '<p class="ac-page-sub">' + esc(sub) + '</p></div>';
  }

  // Config source: the runtime /config API (DIC-465) when reachable, else the
  // baked window.COUNTY fallback (county-config.js).
  var API_BASE = window.ADMIN_API || '/api';
  // The explainer plugins live in the Map Buddy service; resolve its base the same
  // way the viewer does (window override first, for testing).
  function explainBase() {
    var isLocal = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
    return window.MAP_BUDDY_API ||
      (window.COUNTY && COUNTY.endpoints && COUNTY.endpoints.mapBuddy) ||
      (isLocal && '/map-buddy-api') ||
      'https://map-buddy-toaozre74a-uc.a.run.app';
  }
  var COUNTY_KEY = window.PV_COUNTY_KEY || 'vanburen';
  var STATE = {
    config: window.COUNTY || {}, source: 'fallback',
    editing: false, draft: null,
    token: window.PV_ADMIN_TOKEN || '',   // interim write auth (DIC-463 replaces it)
  };
  function loadConfig() {
    return fetch(API_BASE + '/config', { cache: 'no-cache' })
      .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)); })
      .then(function (cfg) { if (cfg && typeof cfg === 'object' && !cfg.error) { STATE.config = cfg; STATE.source = 'api'; } })
      .catch(function () { /* keep the baked fallback */ });
  }

  function clone(o) { return JSON.parse(JSON.stringify(o || {})); }

  // Write call with the interim admin token. Resolves {ok, status, body} and never
  // rejects, so the UI can show a clean message (incl. 503 "not provisioned").
  function apiWrite(method, path, body) {
    return fetch(API_BASE + path, {
      method: method,
      headers: { 'Content-Type': 'application/json', 'X-Admin-Token': STATE.token || '' },
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) { return { ok: r.ok, status: r.status, body: j }; });
    }).catch(function (e) { return { ok: false, status: 0, body: { detail: String(e && e.message || e) } }; });
  }

  function flash(host, kind, msg) {
    var box = host.querySelector('#ac-flash');
    if (box) box.innerHTML = '<div class="ac-flash ac-flash-' + kind + '">' + esc(msg) + '</div>';
  }
  function writeErr(res) {
    if (res.status === 503) return 'Editing is built but not yet provisioned in this environment (writable store — DIC-464 / DIC-400). Save will work once the store is live.';
    if (res.status === 401) return 'Admin token required/invalid (interim auth until DIC-463). Set window.PV_ADMIN_TOKEN.';
    return (res.body && res.body.detail) || ('Request failed (HTTP ' + res.status + ').');
  }

  function setPath(obj, path, value) {
    var parts = path.split('.'), o = obj;
    for (var i = 0; i < parts.length - 1; i++) {
      if (o[parts[i]] == null || typeof o[parts[i]] !== 'object') o[parts[i]] = {};
      o = o[parts[i]];
    }
    o[parts[parts.length - 1]] = value;
  }
  function getPath(obj, path) {
    var parts = path.split('.'), o = obj;
    for (var i = 0; i < parts.length; i++) { if (o == null) return undefined; o = o[parts[i]]; }
    return o;
  }

  // Templates for "Add row" on editable arrays, keyed by their config path.
  var ADD_TEMPLATES = {
    'layers.overlays': { id: '', label: 'New PostGIS layer', type: 'vector', source: '', minZoom: 0, default: false },
    'layers.dataSources': { id: '', label: '', source: '' },
    'choropleth.categories': { value: '', label: '', color: '#888888' },
    'choropleth.stops': { min: 0, label: '', color: '#888888' },
  };
  function arrayAt(path) {
    var arr = getPath(STATE.draft, path);
    if (!Array.isArray(arr)) { setPath(STATE.draft, path, []); arr = getPath(STATE.draft, path); }
    return arr;
  }
  // Find an "add row" template by exact path or by trailing-segment match, so
  // per-layer paths (styling.layers.<id>.choropleth.categories) reuse one template.
  function templateFor(path) {
    if (ADD_TEMPLATES[path]) return ADD_TEMPLATES[path];
    var keys = Object.keys(ADD_TEMPLATES);
    for (var i = 0; i < keys.length; i++) {
      if (path.slice(-(keys[i].length + 1)) === '.' + keys[i]) return ADD_TEMPLATES[keys[i]];
    }
    return {};
  }
  function arrayAdd(path) { arrayAt(path).push(clone(templateFor(path))); }
  function arrayRemove(path, idx) {
    var arr = getPath(STATE.draft, path);
    if (Array.isArray(arr) && idx >= 0 && idx < arr.length) arr.splice(idx, 1);
  }

  // ── County Configuration module (DIC-458 view · DIC-464/466 editing) ────────
  function renderCounty(host) {
    var editing = STATE.editing;
    var C = editing ? (STATE.draft || {}) : (STATE.config || {});
    var m = C.map || {}, ep = C.endpoints || {}, forms = C.forms || {};
    var propClass = (C.labels && C.labels.propClass) || {};
    var schoolDist = (C.labels && C.labels.schoolDist) || {};

    var srcNote = STATE.source === 'api'
      ? 'Loaded live from the runtime <code>/config</code> API (<b>DIC-465</b>).'
      : 'Runtime <code>/config</code> API (<b>DIC-465</b>) not reachable — showing the baked <code>county-config.js</code> fallback.';

    function code(v) { return '<code>' + esc(v) + '</code>'; }
    function display(val, type) {
      if (val == null || val === '') return '—';
      return type === 'json' ? code(JSON.stringify(val)) : esc(val);
    }
    // A field renders as static text (view) or a bound input (edit).
    function field(label, path, val, type) {
      var cell;
      if (editing) {
        var iv = type === 'json' ? JSON.stringify(val) : (val == null ? '' : val);
        cell = '<input class="ac-input" data-path="' + path + '" data-type="' + (type || 'str') + '" value="' + esc(iv) + '">';
      } else {
        cell = display(val, type);
      }
      return '<dt>' + esc(label) + '</dt><dd>' + cell + '</dd>';
    }

    var toolbar = editing
      ? '<button class="ac-btn ac-btn-primary" data-act="save">Save draft</button>' +
        '<button class="ac-btn ac-btn-primary" data-act="publish">Publish</button>' +
        '<button class="ac-btn" data-act="cancel">Cancel</button>'
      : '<button class="ac-btn ac-btn-primary" data-act="edit">Edit configuration</button>' +
        '<button class="ac-btn" data-act="history">Version history</button>';

    var banner = editing
      ? '<div class="ac-banner ac-banner-edit"><span>✎</span><div><b>Editing a draft.</b> ' +
        '<b>Save draft</b> stores your changes; <b>Publish</b> makes the draft the live config as a new version. ' + srcNote + '</div></div>'
      : '<div class="ac-banner"><span>ⓘ</span><div>' + srcNote +
        ' Editing writes to the config store (<b>DIC-464</b>); real auth is <b>DIC-463</b>.</div></div>';

    var html =
      '<div class="ac-page-head ac-page-head-row"><div>' +
        '<h1 class="ac-page-title">County Configuration</h1>' +
        '<p class="ac-page-sub">Identity, map defaults, endpoints, and reference lookups for this county.</p></div>' +
        '<div class="ac-toolbar">' + toolbar + '</div></div>' +
      '<div id="ac-flash"></div>' + banner +

      '<div class="ac-card"><div class="ac-card-head"><h2 class="ac-card-title">Identity</h2></div>' +
        '<dl class="ac-grid">' +
          field('Name', 'name', C.name, 'str') +
          field('State', 'state', C.state, 'str') +
          field('Data request form', 'forms.dataRequest', forms.dataRequest, 'str') +
        '</dl></div>' +

      '<div class="ac-card"><div class="ac-card-head"><h2 class="ac-card-title">Map defaults</h2></div>' +
        '<dl class="ac-grid">' +
          field('Center [lng, lat]', 'map.center', m.center, 'json') +
          field('Default zoom', 'map.zoom', m.zoom, 'num') +
          field('Extent', 'map.extent', m.extent, 'json') +
        '</dl></div>' +

      '<div class="ac-card"><div class="ac-card-head"><h2 class="ac-card-title">Endpoints</h2></div>' +
        '<dl class="ac-grid">' +
          field('Map Buddy AI', 'endpoints.mapBuddy', ep.mapBuddy, 'str') +
        '</dl></div>' +

      '<div class="ac-card"><div class="ac-card-head"><h2 class="ac-card-title">Reference lookups</h2>' +
        '<span class="ac-card-note">code → name maps' + (editing ? ' · edit via API for now' : ' shared by the popup &amp; explainers') + '</span></div>' +
        '<dl class="ac-grid">' +
          '<dt>Property classes</dt><dd>' + Object.keys(propClass).length + ' codes ' +
            '<button class="ac-lookup-toggle" data-lookup="propClass">View</button></dd>' +
          '<dt>School districts</dt><dd>' + Object.keys(schoolDist).length + ' codes ' +
            '<button class="ac-lookup-toggle" data-lookup="schoolDist">View</button></dd>' +
        '</dl><div id="ac-lookup-out"></div></div>' +
      '<div id="ac-history"></div>';

    host.innerHTML = html;
    wireCounty(host, { propClass: propClass, schoolDist: schoolDist });
  }

  function toggleLookup(host, btn) {
    var maps = host._maps || {};
    var out = host.querySelector('#ac-lookup-out');
    var key = btn.getAttribute('data-lookup');
    if (host._lookupShown === key) {
      out.innerHTML = ''; host._lookupShown = null;
      host.querySelectorAll('[data-lookup]').forEach(function (b) { b.textContent = 'View'; });
      return;
    }
    host._lookupShown = key;
    host.querySelectorAll('[data-lookup]').forEach(function (b) { b.textContent = b === btn ? 'Hide' : 'View'; });
    var rows = Object.keys(maps[key] || {}).sort().map(function (k) {
      return '<tr><td>' + esc(k) + '</td><td>' + esc(maps[key][k]) + '</td></tr>';
    }).join('');
    out.innerHTML = '<table class="ac-table"><thead><tr><th>Code</th><th>Name</th></tr></thead><tbody>' + rows + '</tbody></table>';
  }

  // Delegated handlers attach ONCE to the persistent #ac-content host (re-rendering
  // replaces its innerHTML, so per-render addEventListener would stack and fire N×).
  // The currently-shown module id (module scope so the shared edit wiring can
  // re-render the right module after an action).
  var _active = null;
  // Which styling layer the Styling module is focused on (view preference, not a
  // draft edit). Resolved to a valid id at render time.
  var _styleLayer = null;
  function activeRenderer() {
    for (var i = 0; i < MODULES.length; i++) { if (MODULES[i].id === _active) return MODULES[i].render; }
    return renderCounty;
  }

  // Delegated edit wiring, attached ONCE to the persistent #ac-content host. It
  // dispatches to whichever module is active, so editable modules (County,
  // Styling, …) share one handler instead of each stacking listeners.
  function wireEditHost(host) {
    if (host._editWired) return;
    host._editWired = true;
    host.addEventListener('input', function (e) {
      // "Add a layer" pulldown (Data module) — preview the picked layer.
      if (e.target.closest('[data-pg-pick]')) return updatePickMeta(host);
      // Layer picker (Styling module) — a view selector, works in view + edit.
      var picker = e.target.closest('[data-style-layer]');
      if (picker) { _styleLayer = picker.value; return activeRenderer()(host); }
      var inp = e.target.closest('[data-path]');
      if (!inp || !STATE.editing) return;
      var path = inp.getAttribute('data-path'), type = inp.getAttribute('data-type'), raw = inp.value, val;
      if (type === 'num') { if (raw === '') { val = null; } else { val = Number(raw); if (isNaN(val)) return; } }
      else if (type === 'bool') { val = inp.checked; }
      else if (type === 'json') { try { val = JSON.parse(raw); inp.classList.remove('ac-input-err'); } catch (_) { inp.classList.add('ac-input-err'); return; } }
      else { val = raw; }
      setPath(STATE.draft, path, val);
      // Some controls (e.g. a mode <select>) change which fields are shown;
      // re-render the active module so the form reflects the new value.
      if (inp.hasAttribute('data-rerender')) activeRenderer()(host);
    });
    host.addEventListener('click', function (e) {
      var act = e.target.closest('[data-act]');
      if (act) return onAction(host, act.getAttribute('data-act'), activeRenderer());
      var rb = e.target.closest('[data-rollback]');
      if (rb) return doRollback(host, parseInt(rb.getAttribute('data-rollback'), 10), activeRenderer());
      var pick = e.target.closest('[data-scheme-pick]');
      if (pick && STATE.editing) { setPath(STATE.draft, 'styling.colorScheme', pick.getAttribute('data-scheme-pick')); return activeRenderer()(host); }
      var add = e.target.closest('[data-add]');
      if (add && STATE.editing) { arrayAdd(add.getAttribute('data-add')); return activeRenderer()(host); }
      var rem = e.target.closest('[data-remove]');
      if (rem && STATE.editing) { arrayRemove(rem.getAttribute('data-remove'), parseInt(rem.getAttribute('data-index'), 10)); return activeRenderer()(host); }
      var lk = e.target.closest('[data-lookup]');
      if (lk) return toggleLookup(host, lk);
      var addpick = e.target.closest('[data-add-pick]');
      if (addpick) return addPickedLayer(host);
    });
  }
  function wireCounty(host, maps) { host._maps = maps; wireEditHost(host); }

  var AUTHOR = window.PV_ADMIN_USER || 'console';

  // Generic edit/save/publish/history actions, shared by any editable module.
  // `rerender(host)` re-draws the active module; defaults to County.
  function onAction(host, act, rerender) {
    rerender = rerender || renderCounty;
    if (act === 'edit') {
      STATE.editing = true; STATE.draft = clone(STATE.config); rerender(host);
      // Continue an existing server-side draft if there is one.
      apiWrite('GET', '/config/' + COUNTY_KEY + '/draft').then(function (res) {
        if (res.ok && res.body && !res.body.error) { STATE.draft = res.body; if (STATE.editing) rerender(host); }
      });
      return;
    }
    if (act === 'cancel') { STATE.editing = false; STATE.draft = null; rerender(host); return; }
    if (act === 'save') {
      apiWrite('PUT', '/config/' + COUNTY_KEY + '/draft', { payload: STATE.draft, author: AUTHOR }).then(function (res) {
        flash(host, res.ok ? 'ok' : 'err', res.ok ? 'Draft saved.' : writeErr(res));
      });
      return;
    }
    if (act === 'publish') {
      apiWrite('PUT', '/config/' + COUNTY_KEY + '/draft', { payload: STATE.draft, author: AUTHOR }).then(function (r1) {
        if (!r1.ok) { flash(host, 'err', writeErr(r1)); return; }
        apiWrite('POST', '/config/' + COUNTY_KEY + '/publish', { author: AUTHOR, note: 'Published from console' }).then(function (res) {
          if (!res.ok) { flash(host, 'err', writeErr(res)); return; }
          loadConfig().then(function () { STATE.editing = false; STATE.draft = null; rerender(host); flash(host, 'ok', 'Published version ' + res.body.version + '.'); });
        });
      });
      return;
    }
    if (act === 'history') { loadHistory(host); return; }
  }

  function loadHistory(host) {
    var box = host.querySelector('#ac-history');
    box.innerHTML = '<div class="ac-card"><div class="ac-card-head"><h2 class="ac-card-title">Version history</h2></div><p class="ac-readonly">Loading…</p></div>';
    apiWrite('GET', '/config/' + COUNTY_KEY + '/versions').then(function (res) {
      if (!res.ok) { box.innerHTML = '<div class="ac-card"><div class="ac-card-head"><h2 class="ac-card-title">Version history</h2></div><p class="ac-readonly">' + esc(writeErr(res)) + '</p></div>'; return; }
      var vs = (res.body && res.body.versions) || [];
      var rows = vs.map(function (v) {
        return '<tr><td>v' + esc(v.version) + '</td><td>' + esc(v.note || '') + '</td><td>' + esc(v.created_by || '') + '</td>' +
          '<td>' + esc((v.created_at || '').slice(0, 19).replace('T', ' ')) + '</td>' +
          '<td><button class="ac-btn ac-btn-sm" data-rollback="' + esc(v.version) + '">Restore</button></td></tr>';
      }).join('');
      box.innerHTML = '<div class="ac-card"><div class="ac-card-head"><h2 class="ac-card-title">Version history</h2>' +
        '<span class="ac-card-note">' + vs.length + ' published version(s)</span></div>' +
        (vs.length ? '<table class="ac-table"><thead><tr><th>Version</th><th>Note</th><th>By</th><th>When</th><th></th></tr></thead><tbody>' + rows + '</tbody></table>'
                   : '<p class="ac-readonly">No published versions yet.</p>') + '</div>';
    });
  }

  function doRollback(host, version, rerender) {
    rerender = rerender || renderCounty;
    apiWrite('POST', '/config/' + COUNTY_KEY + '/rollback', { version: version, author: AUTHOR }).then(function (res) {
      if (!res.ok) { flash(host, 'err', writeErr(res)); return; }
      loadConfig().then(function () { rerender(host); loadHistory(host); flash(host, 'ok', 'Restored v' + version + ' as version ' + res.body.version + '.'); });
    });
  }

  // ── Roadmap placeholder (modules still to build) ───────────────────────────
  function roadmap(title, sub, epic, items) {
    return function (host) {
      host.innerHTML = pageHead(title, sub) +
        '<div class="ac-card ac-roadmap"><div class="ac-card-head"><h2 class="ac-card-title">Planned</h2>' +
          '<span class="ac-epic">' + esc(epic) + '</span></div>' +
          '<ul>' + items.map(function (i) { return '<li>' + esc(i) + '</li>'; }).join('') + '</ul></div>';
    };
  }

  // ── Intelligence module: explainer-plugin admin backend (DIC-459, read-only) ─
  function renderIntelligence(host) {
    host.innerHTML = pageHead('Intelligence — Explainer Plugins',
      'Each explainer is a callable plugin with its own LLM context — system prompt, injected reference material, and model. Read-only for now; editing lands with the writable store.') +
      '<div class="ac-banner"><span>ⓘ</span><div>Live config from the Map Buddy service. Editing &amp; publish need the writable store (<b>DIC-464</b>) + auth (<b>DIC-463</b>).</div></div>' +
      '<div id="ac-xp-list"><p class="ac-readonly">Loading explainer plugins…</p></div>';
    var out = host.querySelector('#ac-xp-list');
    fetch(explainBase() + '/explainers', { cache: 'no-cache' })
      .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)); })
      .then(function (res) {
        var xs = (res && res.explainers) || [];
        out.innerHTML = xs.length ? xs.map(xpCard).join('') : '<p class="ac-readonly">No explainer plugins registered.</p>';
        wireCollapsibles(out);
      })
      .catch(function (e) {
        out.innerHTML = '<div class="ac-card"><p class="ac-readonly">Couldn’t reach the Map Buddy service (' + esc(e.message) +
          '). The explainer plugins live there; this view needs that service running (it goes live with the next Map Buddy redeploy, DIC-452).</p></div>';
      });
  }
  function _collapse(id, label, body, chars) {
    return '<button class="ac-collapse" data-collapse="' + esc(id) + '" aria-expanded="false">' +
      '<span class="ac-arrow">▸</span> ' + esc(label) +
      (chars != null ? ' <span class="ac-xp-chars">' + chars + ' chars</span>' : '') + '</button>' +
      '<pre class="ac-xp-pre" id="' + esc(id) + '" hidden>' + esc(body || '') + '</pre>';
  }
  function xpCard(x) {
    var blocks = (x.context_blocks || []).map(function (b, i) {
      return '<div class="ac-xp-block">' + _collapse('blk-' + x.id + '-' + i, b.title, b.body, b.chars) + '</div>';
    }).join('');
    return '<div class="ac-card ac-xp-card" data-xp-id="' + esc(x.id) + '">' +
      '<div class="ac-card-head"><h2 class="ac-card-title">' + esc(x.label) + '</h2>' +
        '<span class="ac-xp-model">' + esc(x.model || '—') + '</span></div>' +
      '<dl class="ac-grid">' +
        '<dt>Plugin id</dt><dd><code>' + esc(x.id) + '</code></dd>' +
        '<dt>Audience</dt><dd>' + esc(x.audience || '—') + '</dd>' +
        '<dt>Callable</dt><dd><code>' + esc(x.callable_via || '—') + '</code></dd>' +
      '</dl>' +
      '<div class="ac-xp-section">' + _collapse('sp-' + x.id, 'System prompt', x.system_prompt, (x.system_prompt || '').length) + '</div>' +
      (blocks ? '<div class="ac-xp-section"><div class="ac-xp-blocks-title">Injected context (' + (x.context_blocks || []).length + ')</div>' + blocks + '</div>' : '') +
      '</div>';
  }
  // Toggle the <pre> next to each collapse button.
  function wireCollapsibles(root) {
    root.querySelectorAll('[data-collapse]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var el = document.getElementById(btn.getAttribute('data-collapse'));
        if (!el) return;
        var show = el.hasAttribute('hidden');
        if (show) el.removeAttribute('hidden'); else el.setAttribute('hidden', '');
        var arrow = btn.querySelector('.ac-arrow'); if (arrow) arrow.textContent = show ? '▾' : '▸';
        btn.setAttribute('aria-expanded', show ? 'true' : 'false');
      });
    });
  }

  // ── Styling module (DIC-460 — read + edit) ──────────────────────────────────
  function _swatch(c) { return c ? '<span class="ac-swatch" style="background:' + esc(c) + '" title="' + esc(c) + '"></span>' : ''; }
  function renderStyling(host) {
    var editing = STATE.editing;
    var s = (editing ? (STATE.draft && STATE.draft.styling) : (STATE.config && STATE.config.styling)) || {};
    if (!s.schemes && !s.layers && !s.labels) {
      host.innerHTML = pageHead('Styling', 'Color scheme, theme, per-layer paint, and labels for this county.') +
        '<div class="ac-card"><p class="ac-readonly">No styling config in the manifest yet.</p></div>';
      return;
    }
    var lb = s.labels || {};
    // Per-layer styling (DIC-460): pick the focused layer (_styleLayer view
    // preference, default first). The paint + choropleth cards target this layer.
    var layers = s.layers || {};
    var layerIds = Object.keys(layers);
    var hasLayer = layerIds.length > 0;
    var selId = (_styleLayer && layers[_styleLayer]) ? _styleLayer : layerIds[0];
    _styleLayer = selId;
    var lyr = (selId && layers[selId]) || {};
    var lyrLabel = lyr.label || selId || 'layer';
    var lp = 'styling.layers.' + selId;        // config path prefix for this layer
    var paint = lyr.paint || {};
    var pl = paint.light || {}, pd = paint.dark || {};

    // Geometry type drives which styling tools show (DIC-503). Resolved from the
    // layer's overlay registration; parcels is polygon; fall back to the presence
    // of a line/point style block.
    var Cfg = (editing ? STATE.draft : STATE.config) || {};
    var overlays = (Cfg.layers || {}).overlays || [];
    function geomTypeFor(id) {
      if (id === 'parcels') return 'polygon';
      var ov = overlays.filter(function (o) { return o.id === id; })[0];
      if (ov && ov.geomType) return String(ov.geomType).toLowerCase();
      if (layers[id] && layers[id].line) return 'line';
      if (layers[id] && layers[id].point) return 'point';
      return 'polygon';
    }
    // Attributes available to label / color by — from the layer's tiles (DIC-503).
    function layerFields(id) {
      if (id === 'parcels') {
        var ch = (layers.parcels && layers.parcels.choropleth) || {};
        return ch.fields || [];
      }
      var ov = overlays.filter(function (o) { return o.id === id; })[0];
      return (ov && ov.fields) || [];
    }

    function sel(path, val, opts) {
      return '<select class="ac-input ac-input-sm" data-path="' + path + '" data-type="str">' +
        opts.map(function (o) { return '<option value="' + esc(o) + '"' + (o === val ? ' selected' : '') + '>' + esc(o) + '</option>'; }).join('') + '</select>';
    }
    function colorCell(path, val) {
      if (!editing) return _swatch(val) + ' <code>' + esc(val || '—') + '</code>';
      return '<input type="color" class="ac-color" data-path="' + path + '" data-type="str" value="' + esc(val || '#000000') + '"> <code>' + esc(val || '—') + '</code>';
    }
    function chip(sc) {
      var act = sc.id === s.colorScheme;
      var inner = _swatch(sc.accent) + _swatch(sc.interactive) + '<span class="ac-scheme-label">' + esc(sc.label) + (act ? ' <span class="ac-xp-chars">default</span>' : '') + '</span>';
      return editing
        ? '<button type="button" class="ac-scheme ac-scheme-pick' + (act ? ' is-active' : '') + '" data-scheme-pick="' + esc(sc.id) + '">' + inner + '</button>'
        : '<div class="ac-scheme' + (act ? ' is-active' : '') + '">' + inner + '</div>';
    }

    // ── Choropleth (DIC-460): color parcels by a tile attribute ────────────────
    // Editable enable/attribute/mode/transform/fallback + the active ramp
    // (categories for 'categorical', stops for 'graduated'). The viewer reads
    // styling.choropleth and builds the MapLibre fill expression + legend.
    function txt(path, val, ph) {
      return '<input class="ac-input ac-input-sm" data-path="' + path + '" data-type="str" value="' +
        esc(val == null ? '' : val) + '"' + (ph ? ' placeholder="' + esc(ph) + '"' : '') + '>';
    }
    function numin(path, val) {
      return '<input type="number" class="ac-input ac-input-sm" data-path="' + path + '" data-type="num" value="' +
        esc(val == null ? '' : val) + '" style="max-width:84px">';
    }
    function selR(path, val, opts, rerender) {
      return '<select class="ac-input ac-input-sm" data-path="' + path + '" data-type="str"' + (rerender ? ' data-rerender' : '') + '>' +
        opts.map(function (o) {
          var v = o.v != null ? o.v : o, lbl = o.l != null ? o.l : o;
          return '<option value="' + esc(v) + '"' + (v === (val == null ? '' : val) ? ' selected' : '') + '>' + esc(lbl) + '</option>';
        }).join('') + '</select>';
    }
    // Choropleth editor for the selected layer (paths under styling.layers.<id>).
    function choroCards() {
      if (!hasLayer) return '';
      var ch = lyr.choropleth || {};
      var cp = lp + '.choropleth';
      var cats = ch.categories || [], stops = ch.stops || [];
      var attrOpts = (ch.fields && ch.fields.length) ? ch.fields : ['prop_class', 'gis_acres', 'municipality', 'owner_name', 'parcel_no'];
      var note = ch.enabled ? 'on · ' + esc(ch.attribute || '—') : 'off';
      var settings = editing
        ? '<dl class="ac-grid">' +
            '<dt>Enabled</dt><dd><input type="checkbox" data-path="' + cp + '.enabled" data-type="bool"' + (ch.enabled ? ' checked' : '') +
              '> <span class="ac-card-note">color ' + esc(lyrLabel) + ' by the attribute below</span></dd>' +
            '<dt>Attribute</dt><dd>' + selR(cp + '.attribute', ch.attribute, attrOpts) + '</dd>' +
            '<dt>Mode</dt><dd>' + selR(cp + '.mode', ch.mode, ['categorical', 'graduated'], true) + '</dd>' +
            '<dt>Transform</dt><dd>' + selR(cp + '.transform', ch.transform, [{ v: '', l: '(none)' }, { v: 'classGroup', l: 'classGroup' }]) +
              ' <span class="ac-card-note">classGroup → first digit of prop_class</span></dd>' +
            '<dt>Fallback</dt><dd>' + colorCell(cp + '.fallback', ch.fallback) + '</dd></dl>'
        : '<dl class="ac-grid">' +
            '<dt>Enabled</dt><dd>' + (ch.enabled ? 'Yes' : 'No') + '</dd>' +
            (ch.enabled ? (
              '<dt>Attribute</dt><dd><code>' + esc(ch.attribute || '—') + '</code></dd>' +
              '<dt>Mode</dt><dd>' + esc(ch.mode || '—') + (ch.transform === 'classGroup' ? ' · classGroup' : '') + '</dd>' +
              '<dt>Fallback</dt><dd>' + _swatch(ch.fallback) + ' <code>' + esc(ch.fallback || '—') + '</code></dd>'
            ) : '') + '</dl>';

      var settingsCard =
        '<div class="ac-card"><div class="ac-card-head"><h2 class="ac-card-title">Choropleth</h2>' +
          '<span class="ac-card-note">' + (editing ? 'color ' + esc(lyrLabel) + ' by an attribute' : note) + '</span></div>' +
          settings +
          (!editing && !ch.enabled ? '<p class="ac-readonly">Off — ' + esc(lyrLabel) + ' uses the solid paint above. Edit to color by an attribute.</p>' : '') +
        '</div>';

      // Only the ramp matching the active mode is shown/edited.
      if (!editing && !ch.enabled) return settingsCard;
      var graduated = ch.mode === 'graduated';
      var rampCard;
      if (graduated) {
        var srows = stops.map(function (st, i) {
          var p = cp + '.stops.' + i;
          return editing
            ? '<tr><td>' + colorCell(p + '.color', st.color) + '</td><td>' + numin(p + '.min', st.min) + '</td>' +
              '<td>' + txt(p + '.label', st.label, '≥ ' + (st.min != null ? st.min : '')) + '</td>' +
              '<td><button class="ac-btn ac-btn-sm" data-remove="' + cp + '.stops" data-index="' + i + '">Remove</button></td></tr>'
            : '<tr><td>' + _swatch(st.color) + ' <code>' + esc(st.color || '—') + '</code></td><td>' + esc(st.min != null ? st.min : '—') + '</td><td>' + esc(st.label || '—') + '</td></tr>';
        }).join('');
        if (!srows) srows = '<tr><td colspan="' + (editing ? 4 : 3) + '" class="ac-readonly">No stops yet' + (editing ? ' — add one below.' : '.') + '</td></tr>';
        rampCard =
          '<div class="ac-card"><div class="ac-card-head"><h2 class="ac-card-title">Color stops</h2>' +
            '<span class="ac-card-note">≥ min → color (step)</span></div>' +
            '<table class="ac-table"><thead><tr><th>Color</th><th>Min</th><th>Label</th>' + (editing ? '<th></th>' : '') + '</tr></thead><tbody>' + srows + '</tbody></table>' +
            (editing ? '<div class="ac-add-row"><button class="ac-btn ac-btn-sm" data-add="' + cp + '.stops">+ Add stop</button></div>' : '') +
          '</div>';
      } else {
        var crows = cats.map(function (c, i) {
          var p = cp + '.categories.' + i;
          return editing
            ? '<tr><td>' + colorCell(p + '.color', c.color) + '</td><td>' + txt(p + '.value', c.value, '1') + '</td>' +
              '<td>' + txt(p + '.label', c.label, 'Residential') + '</td>' +
              '<td><button class="ac-btn ac-btn-sm" data-remove="' + cp + '.categories" data-index="' + i + '">Remove</button></td></tr>'
            : '<tr><td>' + _swatch(c.color) + ' <code>' + esc(c.color || '—') + '</code></td><td><code>' + esc(c.value || '—') + '</code></td><td>' + esc(c.label || '—') + '</td></tr>';
        }).join('');
        if (!crows) crows = '<tr><td colspan="' + (editing ? 4 : 3) + '" class="ac-readonly">No categories yet' + (editing ? ' — add one below.' : '.') + '</td></tr>';
        rampCard =
          '<div class="ac-card"><div class="ac-card-head"><h2 class="ac-card-title">Categories</h2>' +
            '<span class="ac-card-note">value → color (match)</span></div>' +
            '<table class="ac-table"><thead><tr><th>Color</th><th>Value</th><th>Label</th>' + (editing ? '<th></th>' : '') + '</tr></thead><tbody>' + crows + '</tbody></table>' +
            (editing ? '<div class="ac-add-row"><button class="ac-btn ac-btn-sm" data-add="' + cp + '.categories">+ Add category</button></div>' : '') +
          '</div>';
      }
      return settingsCard + rampCard;
    }

    // View-aware number / select fields (colorCell already branches on editing).
    function numField(path, val, sfx) {
      return editing ? numin(path, val) : (val == null || val === '' ? '—' : esc(val) + (sfx ? ' ' + sfx : ''));
    }
    function selField(path, val, opts) { return editing ? selR(path, val, opts) : esc(val || '—'); }

    // Geometry-specific control rows (each returns <dt>/<dd> pairs inside the dl).
    function polygonRows() {
      return '<dt>Light — fill</dt><dd>' + colorCell(lp + '.paint.light.fill', pl.fill) + '</dd>' +
        '<dt>Light — stroke</dt><dd>' + colorCell(lp + '.paint.light.stroke', pl.stroke) + '</dd>' +
        '<dt>Dark — fill</dt><dd>' + colorCell(lp + '.paint.dark.fill', pd.fill) + '</dd>' +
        '<dt>Dark — stroke</dt><dd>' + colorCell(lp + '.paint.dark.stroke', pd.stroke) + '</dd>';
    }
    function lineRows() {
      var ln = lyr.line || {}, ll = ln.light || {}, ld = ln.dark || {};
      return '<dt>Width</dt><dd>' + numField(lp + '.line.width', ln.width, 'px') + '</dd>' +
        '<dt>Opacity</dt><dd>' + numField(lp + '.line.opacity', ln.opacity) + '</dd>' +
        '<dt>Dash</dt><dd>' + selField(lp + '.line.dash', ln.dash || 'solid', ['solid', 'dashed', 'dotted']) + '</dd>' +
        '<dt>Casing width</dt><dd>' + numField(lp + '.line.casingWidth', ln.casingWidth) +
          ' <span class="ac-card-note">outline under the line (0 = none)</span></dd>' +
        '<dt>Glow width</dt><dd>' + numField(lp + '.line.glowWidth', ln.glowWidth) +
          ' <span class="ac-card-note">blurred halo (0 = none)</span></dd>' +
        '<dt>Light — line</dt><dd>' + colorCell(lp + '.line.light.color', ll.color) + '</dd>' +
        '<dt>Light — casing</dt><dd>' + colorCell(lp + '.line.light.casingColor', ll.casingColor) + '</dd>' +
        '<dt>Light — glow</dt><dd>' + colorCell(lp + '.line.light.glowColor', ll.glowColor) + '</dd>' +
        '<dt>Dark — line</dt><dd>' + colorCell(lp + '.line.dark.color', ld.color) + '</dd>' +
        '<dt>Dark — casing</dt><dd>' + colorCell(lp + '.line.dark.casingColor', ld.casingColor) + '</dd>' +
        '<dt>Dark — glow</dt><dd>' + colorCell(lp + '.line.dark.glowColor', ld.glowColor) + '</dd>';
    }
    function pointRows() {
      var pt = lyr.point || {}, ptl = pt.light || {}, ptd = pt.dark || {};
      return '<dt>Radius</dt><dd>' + numField(lp + '.point.radius', pt.radius, 'px') + '</dd>' +
        '<dt>Stroke width</dt><dd>' + numField(lp + '.point.strokeWidth', pt.strokeWidth) + '</dd>' +
        '<dt>Light — fill</dt><dd>' + colorCell(lp + '.point.light.color', ptl.color) + '</dd>' +
        '<dt>Light — stroke</dt><dd>' + colorCell(lp + '.point.light.strokeColor', ptl.strokeColor) + '</dd>' +
        '<dt>Dark — fill</dt><dd>' + colorCell(lp + '.point.dark.color', ptd.color) + '</dd>' +
        '<dt>Dark — stroke</dt><dd>' + colorCell(lp + '.point.dark.strokeColor', ptd.strokeColor) + '</dd>';
    }

    // Label tool (DIC-503) — works for any geometry; the field picker is driven
    // by the layer's real tile attributes. Placement note follows geometry.
    function labelCard() {
      var lab = lyr.label || {}, ll = lab.light || {}, ld = lab.dark || {};
      var fields = layerFields(selId);
      var fieldOpts = [{ v: '', l: '(none)' }].concat(fields.map(function (f) { return { v: f, l: f }; }));
      var place = geomTypeFor(selId) === 'line' ? 'along the line' : 'at each feature';
      var body;
      if (!fields.length) {
        body = '<p class="ac-readonly">This layer’s tiles expose no label-able attributes.</p>';
      } else if (editing) {
        body = '<dl class="ac-grid">' +
          '<dt>Show labels</dt><dd><input type="checkbox" data-path="' + lp + '.label.enabled" data-type="bool"' + (lab.enabled ? ' checked' : '') + '></dd>' +
          '<dt>Label field</dt><dd>' + selR(lp + '.label.field', lab.field, fieldOpts) + '</dd>' +
          '<dt>Text size</dt><dd>' + numin(lp + '.label.size', lab.size) + '</dd>' +
          '<dt>Min zoom</dt><dd>' + numin(lp + '.label.minZoom', lab.minZoom) + '</dd>' +
          '<dt>Halo width</dt><dd>' + numin(lp + '.label.haloWidth', lab.haloWidth) + '</dd>' +
          '<dt>Light — text</dt><dd>' + colorCell(lp + '.label.light.color', ll.color) + '</dd>' +
          '<dt>Light — halo</dt><dd>' + colorCell(lp + '.label.light.haloColor', ll.haloColor) + '</dd>' +
          '<dt>Dark — text</dt><dd>' + colorCell(lp + '.label.dark.color', ld.color) + '</dd>' +
          '<dt>Dark — halo</dt><dd>' + colorCell(lp + '.label.dark.haloColor', ld.haloColor) + '</dd></dl>';
      } else {
        body = '<dl class="ac-grid"><dt>Labels</dt><dd>' + (lab.enabled ? 'On' : 'Off') + '</dd>' +
          (lab.enabled ? '<dt>Field</dt><dd><code>' + esc(lab.field || '—') + '</code></dd>' +
            '<dt>Size · min zoom</dt><dd>' + esc(lab.size || '—') + 'px · z' + esc(lab.minZoom || 0) + '+</dd>' : '') +
          '</dl>';
      }
      return '<div class="ac-card"><div class="ac-card-head"><h2 class="ac-card-title">Labels</h2>' +
        '<span class="ac-card-note">text ' + place + '</span></div>' + body + '</div>';
    }

    // Layer picker + geometry-aware styling card. The picker (a view selector)
    // sets which layer the styling targets; the controls shown depend on the
    // layer's geometry (polygon → fill+choropleth, line → casing/dash/glow,
    // point → radius/stroke). Works in view and edit modes.
    function layerCards() {
      if (!hasLayer) {
        return '<div class="ac-card"><div class="ac-card-head"><h2 class="ac-card-title">Layer styling</h2></div>' +
          '<p class="ac-readonly">No stylable layers in the manifest yet.</p></div>';
      }
      var picker = '<select class="ac-input ac-input-sm" data-style-layer>' +
        layerIds.map(function (id) {
          return '<option value="' + esc(id) + '"' + (id === selId ? ' selected' : '') + '>' + esc((layers[id] && layers[id].label) || id) + '</option>';
        }).join('') + '</select>';
      var gt = geomTypeFor(selId);
      var rows = gt === 'line' ? lineRows() : gt === 'point' ? pointRows() : polygonRows();
      var note = gt === 'line' ? 'line — casing, dash &amp; glow'
        : gt === 'point' ? 'point — radius &amp; stroke'
        : 'fill, stroke &amp; choropleth';
      var lineHint = gt === 'line'
        ? '<p class="ac-readonly" style="margin-top:8px">Width-by-type needs the layer’s tiles to expose a class attribute (DB-side); ' +
          'this layer’s tiles carry only name/feature_type today.</p>'
        : '';
      var card =
        '<div class="ac-card"><div class="ac-card-head"><h2 class="ac-card-title">Layer styling</h2>' +
          '<span class="ac-card-note">' + note + '</span></div>' +
          '<dl class="ac-grid"><dt>Layer</dt><dd>' + picker + ' <span class="ac-card-note">' + esc(gt) + '</span></dd>' +
            rows + '</dl>' + lineHint + '</div>';
      // Choropleth is polygon-only (colors a fill by attribute); labels apply to
      // every geometry.
      return card + (gt === 'polygon' ? choroCards() : '') + labelCard();
    }

    var toolbar = editing
      ? '<button class="ac-btn ac-btn-primary" data-act="save">Save draft</button>' +
        '<button class="ac-btn ac-btn-primary" data-act="publish">Publish</button>' +
        '<button class="ac-btn" data-act="cancel">Cancel</button>'
      : '<button class="ac-btn ac-btn-primary" data-act="edit">Edit styling</button>' +
        '<button class="ac-btn" data-act="history">Version history</button>';
    var banner = editing
      ? '<div class="ac-banner ac-banner-edit"><span>✎</span><div><b>Editing a draft.</b> <b>Publish</b> makes it the live styling; the viewer reads the published config (scheme, theme, parcel colors).</div></div>'
      : '<div class="ac-banner"><span>ⓘ</span><div>' + _srcNote() + ' The viewer consumes the published styling (color scheme, theme, parcel paint).</div></div>';

    host.innerHTML =
      '<div class="ac-page-head ac-page-head-row"><div>' +
        '<h1 class="ac-page-title">Styling</h1>' +
        '<p class="ac-page-sub">Color scheme, theme, per-layer paint &amp; choropleth, and labels.</p></div>' +
        '<div class="ac-toolbar">' + toolbar + '</div></div>' +
      '<div id="ac-flash"></div>' + banner +
      '<div class="ac-card"><div class="ac-card-head"><h2 class="ac-card-title">Color scheme</h2>' +
        '<span class="ac-card-note">' + (editing ? 'click to set default' : 'default: ' + esc(s.colorScheme || '—')) + '</span></div>' +
        '<div class="ac-schemes">' + (s.schemes || []).map(chip).join('') + '</div></div>' +
      '<div class="ac-card"><div class="ac-card-head"><h2 class="ac-card-title">Theme &amp; basemap</h2></div><dl class="ac-grid">' +
        '<dt>Default theme</dt><dd>' + (editing ? sel('styling.theme', s.theme, ['light', 'dark', 'auto']) : esc(s.theme || '—')) + '</dd>' +
        '<dt>Base layer</dt><dd>' + (editing ? sel('styling.basemap', s.basemap, ['parcels', 'aerial']) : esc(s.basemap || '—')) + '</dd></dl></div>' +
      layerCards() +
      '<div class="ac-card"><div class="ac-card-head"><h2 class="ac-card-title">Parcel labels</h2></div><dl class="ac-grid">' +
        '<dt>Default field</dt><dd>' + (editing ? sel('styling.labels.defaultField', lb.defaultField, lb.fields || []) : esc(lb.defaultField || '—')) + '</dd>' +
        '<dt>Default size</dt><dd>' + (editing ? sel('styling.labels.defaultSize', lb.defaultSize, lb.sizes || ['small', 'medium', 'large']) : esc(lb.defaultSize || '—')) + '</dd>' +
        '<dt>Zoom — large / small</dt><dd>' + (editing
          ? '<input type="number" class="ac-input ac-input-sm" data-path="styling.labels.zoom.largeParcels" data-type="num" value="' + esc((lb.zoom && lb.zoom.largeParcels) || '') + '"> / ' +
            '<input type="number" class="ac-input ac-input-sm" data-path="styling.labels.zoom.smallParcels" data-type="num" value="' + esc((lb.zoom && lb.zoom.smallParcels) || '') + '">'
          : 'large ' + esc((lb.zoom && lb.zoom.largeParcels) || '—') + '+, small ' + esc((lb.zoom && lb.zoom.smallParcels) || '—') + '+') + '</dd></dl></div>' +
      '<div id="ac-history"></div>';

    wireEditHost(host);
  }

  function _srcNote() {
    return STATE.source === 'api' ? 'Loaded live from <code>/config</code>.' : 'Showing the baked manifest fallback.';
  }
  function _plan(items) {
    return '<ul class="ac-plan">' + items.map(function (i) { return '<li>' + i + '</li>'; }).join('') + '</ul>';
  }

  // ── Data & Layers module (DIC-461 — read + edit) ────────────────────────────
  // PostGIS (vector) layers are the editable focus; the legacy WMS/raster
  // overlays are shown read-only as they're being phased out.
  function _isPgLayer(o) { var t = String(o && o.type || '').toLowerCase(); return t === 'vector' || t === 'postgis' || t === 'mvt'; }
  function renderData(host) {
    var editing = STATE.editing;
    var C = editing ? (STATE.draft || {}) : (STATE.config || {});
    var L = C.layers || {};
    var ts = L.tileServer || {};
    var overlays = L.overlays || [];
    var sources = L.dataSources || [];

    // Partition overlays, keeping each one's real index into L.overlays so edits
    // and removals target the right array slot regardless of display grouping.
    var pg = [], ext = [];
    overlays.forEach(function (o, i) { (_isPgLayer(o) ? pg : ext).push({ o: o, i: i }); });

    function txt(path, val, ph) {
      return '<input class="ac-input ac-input-sm" data-path="' + path + '" data-type="str" value="' +
        esc(val == null ? '' : val) + '"' + (ph ? ' placeholder="' + esc(ph) + '"' : '') + '>';
    }
    function num(path, val) {
      return '<input type="number" class="ac-input ac-input-sm" data-path="' + path + '" data-type="num" value="' +
        esc(val == null ? '' : val) + '" style="max-width:78px">';
    }
    function bool(path, val) {
      return '<input type="checkbox" data-path="' + path + '" data-type="bool"' + (val ? ' checked' : '') + '>';
    }

    var toolbar = editing
      ? '<button class="ac-btn ac-btn-primary" data-act="save">Save draft</button>' +
        '<button class="ac-btn ac-btn-primary" data-act="publish">Publish</button>' +
        '<button class="ac-btn" data-act="cancel">Cancel</button>'
      : '<button class="ac-btn ac-btn-primary" data-act="edit">Edit layers</button>' +
        '<button class="ac-btn" data-act="history">Version history</button>';
    var banner = editing
      ? '<div class="ac-banner ac-banner-edit"><span>✎</span><div><b>Editing a draft.</b> ' +
        'Edit the PostGIS (vector) layers, tile server, and data sources, then <b>Publish</b> to make it the live layer config. ' +
        'Legacy WMS/raster overlays are read-only — they’re being phased out.</div></div>'
      : '<div class="ac-banner"><span>ⓘ</span><div>' + _srcNote() +
        ' PostGIS (vector) layers served via the tile server are the editable focus; WMS/raster overlays are being phased out.</div></div>';

    // Tile server (Martin) — the source of every PostGIS vector tile.
    var tileCard =
      '<div class="ac-card"><div class="ac-card-head"><h2 class="ac-card-title">Tile server</h2>' +
        '<span class="ac-card-note">serves the PostGIS vector tiles</span></div><dl class="ac-grid">' +
        '<dt>Provider</dt><dd>' + (editing ? txt('layers.tileServer.provider', ts.provider, 'Martin') : esc(ts.provider || '—')) + '</dd>' +
        '<dt>URL</dt><dd>' + (editing ? txt('layers.tileServer.url', ts.url, '/tiles') : '<code>' + esc(ts.url || '—') + '</code>') + '</dd></dl></div>';

    // PostGIS (vector) layers — the editable registry.
    var pgRows = pg.map(function (r) {
      var p = 'layers.overlays.' + r.i;
      if (editing) {
        return '<tr><td>' + txt(p + '.label', r.o.label) + '</td>' +
          '<td>' + txt(p + '.source', r.o.source, 'PostGIS table / Martin source') + '</td>' +
          '<td>' + num(p + '.minZoom', r.o.minZoom) + '</td>' +
          '<td style="text-align:center">' + bool(p + '.default', r.o.default) + '</td>' +
          '<td><button class="ac-btn ac-btn-sm" data-remove="layers.overlays" data-index="' + r.i + '">Remove</button></td></tr>';
      }
      return '<tr><td>' + esc(r.o.label) + '</td><td><code>' + esc(r.o.source || '—') + '</code></td>' +
        '<td>' + (r.o.minZoom ? ('z' + r.o.minZoom + '+') : 'all') + '</td>' +
        '<td>' + (r.o.default ? 'on' : '') + '</td>' + (editing ? '<td></td>' : '') + '</tr>';
    }).join('');
    if (!pgRows) {
      pgRows = '<tr><td colspan="' + (editing ? 5 : 4) + '" class="ac-readonly">No PostGIS layers yet' +
        (editing ? ' — add one below.' : '.') + '</td></tr>';
    }
    var pgCard =
      '<div class="ac-card"><div class="ac-card-head"><h2 class="ac-card-title">PostGIS layers</h2>' +
        '<span class="ac-card-note">' + pg.length + ' vector layer(s)</span></div>' +
        '<table class="ac-table"><thead><tr><th>Layer</th><th>Source</th><th>Min zoom</th><th>Default on</th>' +
          (editing ? '<th></th>' : '') + '</tr></thead><tbody>' + pgRows + '</tbody></table>' +
        (editing ? '<div class="ac-add-row"><button class="ac-btn ac-btn-sm" data-add="layers.overlays">+ Add PostGIS layer</button></div>' : '') +
      '</div>';

    // Legacy external overlays (WMS / raster) — read-only, phasing out.
    var extCard = ext.length
      ? '<div class="ac-card"><div class="ac-card-head"><h2 class="ac-card-title">External overlays</h2>' +
          '<span class="ac-card-note">WMS / raster — being phased out</span></div>' +
          '<table class="ac-table"><thead><tr><th>Overlay</th><th>Type</th><th>Source</th><th>Min zoom</th></tr></thead><tbody>' +
          ext.map(function (r) {
            return '<tr><td>' + esc(r.o.label) + '</td><td>' + esc(r.o.type) + '</td><td>' + esc(r.o.source) + '</td>' +
              '<td>' + (r.o.minZoom ? ('z' + r.o.minZoom + '+') : 'all') + '</td></tr>';
          }).join('') + '</tbody></table></div>'
      : '';

    // Data sources (PostGIS tables behind the layers).
    var dsRows = sources.map(function (d, i) {
      var p = 'layers.dataSources.' + i;
      if (editing) {
        return '<tr><td>' + txt(p + '.label', d.label) + '</td>' +
          '<td>' + txt(p + '.source', d.source, 'schema.table') + '</td>' +
          '<td><button class="ac-btn ac-btn-sm" data-remove="layers.dataSources" data-index="' + i + '">Remove</button></td></tr>';
      }
      return '<tr><td>' + esc(d.label) + '</td><td><code>' + esc(d.source) + '</code></td></tr>';
    }).join('');
    if (!dsRows) dsRows = '<tr><td colspan="' + (editing ? 3 : 2) + '" class="ac-readonly">No data sources defined.</td></tr>';
    var dsCard =
      '<div class="ac-card"><div class="ac-card-head"><h2 class="ac-card-title">Data sources</h2>' +
        '<span class="ac-card-note">PostGIS tables</span></div>' +
        '<table class="ac-table"><thead><tr><th>Dataset</th><th>Source</th>' + (editing ? '<th></th>' : '') + '</tr></thead><tbody>' + dsRows + '</tbody></table>' +
        (editing ? '<div class="ac-add-row"><button class="ac-btn ac-btn-sm" data-add="layers.dataSources">+ Add data source</button></div>'
                 : '<p class="ac-readonly" style="margin-top:8px">Self-serve ingestion (upload → field-map → validate → publish, versioned) is the planned DIC-461 loader.</p>') +
      '</div>';

    // Add a layer (DIC-502) — pick a PostGIS layer the tile server can serve from
    // an always-ready pulldown; selecting + Add registers it into the draft.
    var pickCard =
      '<div class="ac-card"><div class="ac-card-head"><h2 class="ac-card-title">Add a layer</h2>' +
        '<span class="ac-card-note">PostGIS layers the tile server can serve (DIC-502)</span></div>' +
        '<p class="ac-readonly" style="margin:0 0 10px">Pick a spatial layer already in PostGIS to add it as a viewer overlay — no developer, no DB migration.</p>' +
        '<div class="ac-pick-row">' +
          '<select class="ac-input ac-input-sm" id="ac-pg-pick" data-pg-pick></select>' +
          '<button class="ac-btn ac-btn-sm ac-btn-primary" data-add-pick>Add layer</button>' +
        '</div>' +
        '<div id="ac-pg-pick-meta" style="margin-top:10px"></div>' +
      '</div>';

    host.innerHTML =
      '<div class="ac-page-head ac-page-head-row"><div>' +
        '<h1 class="ac-page-title">Data &amp; Layers</h1>' +
        '<p class="ac-page-sub">PostGIS layers, the tile server, and the data sources behind them.</p></div>' +
        '<div class="ac-toolbar">' + toolbar + '</div></div>' +
      '<div id="ac-flash"></div>' + banner +
      tileCard + pgCard + pickCard + extCard + dsCard +
      '<div id="ac-history"></div>';

    wireEditHost(host);
    loadAvailableLayers(host);            // populate the pulldown immediately
  }

  // ── PostGIS layer discovery (DIC-502) ───────────────────────────────────────
  // Discover spatial layers the tile server can serve (geo.<name>_tiles) and
  // register them into the config draft as vector overlays — no developer.
  function _titleize(id) {
    return String(id || '').split(/[_\s]+/).map(function (w) {
      if (/^plss$/i.test(w)) return 'PLSS';
      return w ? w.charAt(0).toUpperCase() + w.slice(1) : w;
    }).join(' ');
  }
  // A distinct default paint per geometry kind (editable later in Styling).
  function _defaultStyle(geomType) {
    var palette = {
      polygon: { light: { fill: '#2F6B4F', stroke: '#1f4d39' }, dark: { fill: '#4E9A6B', stroke: '#6db38a' } },
      line:    { light: { fill: '#1F5E80', stroke: '#1F5E80' }, dark: { fill: '#2E76A6', stroke: '#7fb6d8' } },
      point:   { light: { fill: '#B58D4A', stroke: '#8B6535' }, dark: { fill: '#d4a862', stroke: '#b8923f' } },
    };
    return (palette[geomType] || palette.polygon);
  }
  function _overlayFromDiscovered(d) {
    return {
      id: d.id, label: _titleize(d.id), type: 'vector',
      source: d.source, sourceLayer: d.sourceLayer,
      geomType: d.geomType || 'polygon', minZoom: 12, default: false,
      dbSource: d.dbSource, fields: d.fields || [],
    };
  }
  // Populate the "add a layer" pulldown with serveable layers not yet registered.
  // Auto-runs whenever the Data module renders, so the dropdown is always ready —
  // adding a layer is just picking it from the list.
  function loadAvailableLayers(host) {
    var sel = host.querySelector('#ac-pg-pick');
    var meta = host.querySelector('#ac-pg-pick-meta');
    if (!sel) return;
    sel.innerHTML = '<option value="">Loading available layers…</option>';
    sel.disabled = true;
    fetch(API_BASE + '/admin/discover/layers', { cache: 'no-cache' })
      .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)); })
      .then(function (res) {
        var layers = (res && res.layers) || [];
        host._discovered = {};
        layers.forEach(function (d) { host._discovered[d.source] = d; });
        // Exclude layers already registered (in the live draft/config).
        var cfg = STATE.editing ? (STATE.draft || {}) : (STATE.config || {});
        var regd = {};
        ((cfg.layers || {}).overlays || []).forEach(function (o) {
          if (String(o.type || '').toLowerCase() === 'vector' && o.source) regd[o.source] = true;
        });
        var avail = layers.filter(function (d) { return !d.registered && !regd[d.source]; });
        if (meta) meta.innerHTML = '';
        if (!avail.length) {
          sel.innerHTML = '<option value="">All available layers added</option>';
          sel.disabled = true;
          return;
        }
        sel.disabled = false;
        sel.innerHTML = '<option value="">Select a layer to add…</option>' +
          avail.map(function (d) {
            var bits = [d.geomType || '—'];
            if (d.rowCount != null) bits.push(Number(d.rowCount).toLocaleString() + ' features');
            return '<option value="' + esc(d.source) + '">' + esc(_titleize(d.id)) + ' — ' + esc(bits.join(', ')) + '</option>';
          }).join('');
      })
      .catch(function (e) {
        sel.innerHTML = '<option value="">Discovery unavailable</option>';
        sel.disabled = true;
        if (meta) meta.innerHTML = '<p class="ac-readonly">Couldn’t reach the tile server / DB (' + esc(e.message) + ').</p>';
      });
  }

  // Preview the picked layer's metadata beneath the pulldown.
  function updatePickMeta(host) {
    var sel = host.querySelector('#ac-pg-pick');
    var meta = host.querySelector('#ac-pg-pick-meta');
    if (!sel || !meta) return;
    var d = sel.value && host._discovered && host._discovered[sel.value];
    meta.innerHTML = d
      ? '<dl class="ac-grid"><dt>Geometry</dt><dd>' + esc(d.geomType || '—') + '</dd>' +
        '<dt>Features</dt><dd>' + (d.rowCount != null ? Number(d.rowCount).toLocaleString() : '—') + '</dd>' +
        '<dt>PostGIS source</dt><dd><code>' + esc(d.dbSource || d.source) + '</code></dd>' +
        '<dt>Tile source</dt><dd><code>' + esc(d.source) + '</code></dd></dl>'
      : '';
  }

  // Add the layer currently selected in the pulldown. Enters edit mode first if
  // needed, so it's a one-step "pick → add".
  function addPickedLayer(host) {
    var sel = host.querySelector('#ac-pg-pick');
    if (!sel || !sel.value) { flash(host, 'err', 'Pick a layer to add first.'); return; }
    if (!STATE.editing) { STATE.editing = true; STATE.draft = clone(STATE.config); }
    addDiscoveredLayer(host, sel.value);
  }

  function addDiscoveredLayer(host, source) {
    var d = host._discovered && host._discovered[source];
    if (!d || !STATE.editing) return;
    var overlays = arrayAt('layers.overlays');
    if (overlays.some(function (o) { return o.source === source; })) return;  // already there
    overlays.push(_overlayFromDiscovered(d));
    // Seed a default per-layer style (DIC-460) so the viewer can paint it.
    setPath(STATE.draft, 'styling.layers.' + d.id, { label: _titleize(d.id), paint: _defaultStyle(d.geomType || 'polygon') });
    renderData(host);                       // re-render: layer now appears under PostGIS layers; pulldown reloads without it
    flash(host, 'ok', 'Added “' + _titleize(d.id) + '”. Publish to make it live in the viewer.');
  }

  // ── Access & Ops module (DIC-462 — read + edit) ─────────────────────────────
  // The `access` block (model, assessment visibility, report inbox, rate-limit)
  // and the data-request form URL are editable via the shared draft→publish flow.
  // The Services card stays read-only here: those endpoints are owned by other
  // modules (tile server → Data & Layers, Map Buddy → County) or are runtime.
  function renderAccess(host) {
    var editing = STATE.editing;
    var C = editing ? (STATE.draft || {}) : (STATE.config || {});
    var A = C.access || {};
    var forms = C.forms || {};
    var ep = C.endpoints || {};
    var ts = (C.layers || {}).tileServer || {};

    function txt(path, val, ph) {
      return '<input class="ac-input" data-path="' + path + '" data-type="str" value="' +
        esc(val == null ? '' : val) + '"' + (ph ? ' placeholder="' + esc(ph) + '"' : '') + '>';
    }
    function bool(path, val) {
      return '<input type="checkbox" data-path="' + path + '" data-type="bool"' + (val ? ' checked' : '') + '>';
    }

    var toolbar = editing
      ? '<button class="ac-btn ac-btn-primary" data-act="save">Save draft</button>' +
        '<button class="ac-btn ac-btn-primary" data-act="publish">Publish</button>' +
        '<button class="ac-btn" data-act="cancel">Cancel</button>'
      : '<button class="ac-btn ac-btn-primary" data-act="edit">Edit access</button>' +
        '<button class="ac-btn" data-act="history">Version history</button>';
    var banner = editing
      ? '<div class="ac-banner ac-banner-edit"><span>✎</span><div><b>Editing a draft.</b> ' +
        'Set the access model, assessment-data visibility, report inbox, and rate-limit flag, then <b>Publish</b>. ' +
        'Service endpoints below are owned by their own modules and stay read-only here.</div></div>'
      : '<div class="ac-banner"><span>ⓘ</span><div>' + _srcNote() +
        ' Embeds, usage dashboards, and a deploy trigger are the planned DIC-462 build.</div></div>';

    host.innerHTML =
      '<div class="ac-page-head ac-page-head-row"><div>' +
        '<h1 class="ac-page-title">Access &amp; Ops</h1>' +
        '<p class="ac-page-sub">Who can see what, how it’s shared, and how staff watch it.</p></div>' +
        '<div class="ac-toolbar">' + toolbar + '</div></div>' +
      '<div id="ac-flash"></div>' + banner +
      '<div class="ac-card"><div class="ac-card-head"><h2 class="ac-card-title">Access</h2></div><dl class="ac-grid">' +
        '<dt>Access model</dt><dd>' + (editing ? txt('access.model', A.model, 'e.g. Public — no sign-in') : esc(A.model || '—')) + '</dd>' +
        '<dt>Assessment data</dt><dd>' + (editing
          ? bool('access.assessmentDataPublic', A.assessmentDataPublic) + ' <span class="ac-card-note">public</span>'
          : (A.assessmentDataPublic ? 'Public' : 'Gated')) + '</dd>' +
        '<dt>Data request form</dt><dd>' + (editing ? txt('forms.dataRequest', forms.dataRequest, 'https://…')
          : (forms.dataRequest ? '<code>' + esc(forms.dataRequest) + '</code>' : '—')) + '</dd>' +
        '<dt>Error reports go to</dt><dd>' + (editing ? txt('access.reportTo', A.reportTo, 'gis@county.gov')
          : '<code>' + esc(A.reportTo || '—') + '</code>') + '</dd>' +
        '<dt>Rate limited</dt><dd>' + (editing
          ? bool('access.rateLimited', A.rateLimited) + ' <span class="ac-card-note">throttle public endpoints</span>'
          : (A.rateLimited ? 'Yes' : 'No')) + '</dd></dl></div>' +
      '<div class="ac-card"><div class="ac-card-head"><h2 class="ac-card-title">Services</h2>' +
        '<span class="ac-card-note">read-only · owned by other modules</span></div><dl class="ac-grid">' +
        '<dt>Parcel API</dt><dd><code>' + esc(API_BASE) + '</code></dd>' +
        '<dt>Tile server</dt><dd><code>' + esc(ts.url || '/tiles') + '</code></dd>' +
        '<dt>Map Buddy AI</dt><dd><code>' + esc(ep.mapBuddy || '—') + '</code></dd></dl></div>' +
      '<div class="ac-card"><div class="ac-card-head"><h2 class="ac-card-title">Planned (DIC-462)</h2></div>' +
        _plan(['Public-vs-staff gating toggles per county', 'Embeds + shareable links (DIC-399 / DIC-340)', 'Data-error report triage dashboard (DIC-391)', 'Usage / analytics + change audit log', 'One-click redeploy trigger (e.g. Map Buddy, DIC-452)']) + '</div>' +
      '<div id="ac-history"></div>';

    wireEditHost(host);
  }

  // ── Module registry ─────────────────────────────────────────────────────────
  var MODULES = [
    { id: 'county', label: 'County Configuration', icon: '◆', render: renderCounty },
    { id: 'intelligence', label: 'Intelligence', icon: '✦', render: renderIntelligence },
    { id: 'styling', label: 'Styling', icon: '◑', render: renderStyling },
    { id: 'data', label: 'Data & Layers', icon: '▤', render: renderData },
    { id: 'access', label: 'Access & Ops', icon: '◈', render: renderAccess },
  ];

  // ── Shell wiring ────────────────────────────────────────────────────────────
  function init() {
    var nav = document.getElementById('ac-nav');
    var content = document.getElementById('ac-content');

    function show(id) {
      var mod = MODULES.filter(function (m) { return m.id === id; })[0] || MODULES[0];
      if (mod.id !== _active) { STATE.editing = false; STATE.draft = null; }  // drop any in-progress edit on switch
      _active = mod.id;
      nav.querySelectorAll('.ac-nav-item').forEach(function (b) {
        b.classList.toggle('is-active', b.getAttribute('data-mod') === mod.id);
      });
      mod.render(content);
      content.focus();
      if (location.hash !== '#' + mod.id) history.replaceState(null, '', '#' + mod.id);
    }

    MODULES.forEach(function (m) {
      var btn = el('<button class="ac-nav-item" data-mod="' + m.id + '">' +
        '<span class="ac-nav-ico">' + m.icon + '</span><span>' + esc(m.label) + '</span>' +
        (m.soon ? '<span class="ac-nav-soon">soon</span>' : '') + '</button>');
      btn.addEventListener('click', function () { show(m.id); });
      nav.appendChild(btn);
    });

    var sel = document.getElementById('ac-county-select');
    var pill = document.getElementById('ac-status');
    function reflect() {
      if (sel && STATE.config && STATE.config.name) sel.options[0].textContent = STATE.config.name;
      if (pill) pill.textContent = STATE.source === 'api' ? 'Live config · read-only' : 'Read-only preview';
    }

    var initial = (location.hash || '').replace('#', '');
    show(MODULES.some(function (m) { return m.id === initial; }) ? initial : 'county');
    reflect();

    // Pull the authoritative manifest from the runtime API, then refresh.
    loadConfig().then(function () { reflect(); show(_active || 'county'); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
}());
