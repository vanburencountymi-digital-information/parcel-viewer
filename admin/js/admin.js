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
  function locked() { return '<span class="ac-field-locked"><span class="ac-lock" title="Editing requires the writable store (DIC-464)">🔒</span></span>'; }

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
  function wireCounty(host, maps) {
    host._maps = maps;
    if (host._countyWired) return;
    host._countyWired = true;

    host.addEventListener('input', function (e) {
      var inp = e.target.closest('[data-path]');
      if (!inp || !STATE.editing) return;
      var path = inp.getAttribute('data-path'), type = inp.getAttribute('data-type'), raw = inp.value, val;
      if (type === 'num') { if (raw === '') { val = null; } else { val = Number(raw); if (isNaN(val)) return; } }
      else if (type === 'json') { try { val = JSON.parse(raw); inp.classList.remove('ac-input-err'); } catch (_) { inp.classList.add('ac-input-err'); return; } }
      else { val = raw; }
      setPath(STATE.draft, path, val);
    });

    host.addEventListener('click', function (e) {
      var act = e.target.closest('[data-act]');
      if (act) return onAction(host, act.getAttribute('data-act'));
      var rb = e.target.closest('[data-rollback]');
      if (rb) return doRollback(host, parseInt(rb.getAttribute('data-rollback'), 10));
      var lk = e.target.closest('[data-lookup]');
      if (lk) return toggleLookup(host, lk);
    });
  }

  var AUTHOR = window.PV_ADMIN_USER || 'console';

  function onAction(host, act) {
    if (act === 'edit') {
      STATE.editing = true; STATE.draft = clone(STATE.config); renderCounty(host);
      // Continue an existing server-side draft if there is one.
      apiWrite('GET', '/config/' + COUNTY_KEY + '/draft').then(function (res) {
        if (res.ok && res.body && !res.body.error) { STATE.draft = res.body; if (STATE.editing) renderCounty(host); }
      });
      return;
    }
    if (act === 'cancel') { STATE.editing = false; STATE.draft = null; renderCounty(host); return; }
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
          loadConfig().then(function () { STATE.editing = false; STATE.draft = null; renderCounty(host); flash(host, 'ok', 'Published version ' + res.body.version + '.'); });
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

  function doRollback(host, version) {
    apiWrite('POST', '/config/' + COUNTY_KEY + '/rollback', { version: version, author: AUTHOR }).then(function (res) {
      if (!res.ok) { flash(host, 'err', writeErr(res)); return; }
      loadConfig().then(function () { renderCounty(host); loadHistory(host); flash(host, 'ok', 'Restored v' + version + ' as version ' + res.body.version + '.'); });
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

  // ── Module registry ─────────────────────────────────────────────────────────
  var MODULES = [
    { id: 'county', label: 'County Configuration', icon: '◆', render: renderCounty },
    { id: 'intelligence', label: 'Intelligence', icon: '✦', render: renderIntelligence },
    { id: 'styling', label: 'Styling', icon: '◑', soon: true,
      render: roadmap('Styling', 'Parcel & label styling, choropleth, themes — moved out of hardcoded JS/CSS into editable config.', 'DIC-460',
        ['Parcel fill/stroke + choropleth by class or AV/TV bands', 'Label field, sizing & zoom thresholds', 'Basemap, light/dark defaults, color-scheme presets', 'Live preview against a sandboxed viewer']) },
    { id: 'data', label: 'Data & Layers', icon: '▤', soon: true,
      render: roadmap('Data & Layers', 'Parcel/assessing ingestion, tiles & overlay registry — the biggest onboarding pain, made self-serve.', 'DIC-461',
        ['Upload / connect → field-map → validate → stage → atomic publish', 'Versioned, rollbackable datasets + async job runner', 'Martin tile refresh', 'WMS overlay registry (wetlands/flood/soils/aerial)']) },
    { id: 'access', label: 'Access & Ops', icon: '◈', soon: true,
      render: roadmap('Access & Ops', 'Gating, embeds, reports, usage & deploy controls.', 'DIC-462',
        ['Public-vs-staff gating of assessment data', 'Embeds + shareable links', 'Data-error report triage dashboard', 'Usage/analytics, audit log, redeploy trigger']) },
  ];

  // ── Shell wiring ────────────────────────────────────────────────────────────
  function init() {
    var nav = document.getElementById('ac-nav');
    var content = document.getElementById('ac-content');
    var active = null;

    function show(id) {
      var mod = MODULES.filter(function (m) { return m.id === id; })[0] || MODULES[0];
      active = mod.id;
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
    loadConfig().then(function () { reflect(); show(active || 'county'); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
}());
