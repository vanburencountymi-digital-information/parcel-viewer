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

  // ── County Configuration module (DIC-458) ──────────────────────────────────
  function renderCounty(host) {
    var C = window.COUNTY || {};
    var m = C.map || {}, ep = C.endpoints || {}, forms = C.forms || {};
    var propClass = (C.labels && C.labels.propClass) || {};
    var schoolDist = (C.labels && C.labels.schoolDist) || {};

    function row(label, value) {
      return '<dt>' + esc(label) + '</dt><dd>' + value + ' ' + locked() + '</dd>';
    }
    function code(v) { return '<code>' + esc(v) + '</code>'; }

    var html =
      pageHead('County Configuration',
        'The identity, map defaults, endpoints, and reference lookups that define this county. Replaces county-config.js once the runtime config API lands.') +
      '<div class="ac-banner"><span>ⓘ</span><div><b>Read-only preview.</b> ' +
        'Editing &amp; publish need the writable config store (<b>DIC-464</b>, blocked by Drake’s <b>DIC-400</b>). ' +
        'The viewer will boot from a runtime <code>/config</code> API (<b>DIC-465</b>) — today this reads the live <code>county-config.js</code> manifest.</div></div>' +

      '<div class="ac-card"><div class="ac-card-head"><h2 class="ac-card-title">Identity</h2></div>' +
        '<dl class="ac-grid">' +
          row('Name', esc(C.name || '—')) +
          row('State', esc(C.state || '—')) +
          row('Data request form', forms.dataRequest ? code(forms.dataRequest) : '—') +
        '</dl></div>' +

      '<div class="ac-card"><div class="ac-card-head"><h2 class="ac-card-title">Map defaults</h2></div>' +
        '<dl class="ac-grid">' +
          row('Center [lng, lat]', m.center ? code(JSON.stringify(m.center)) : '—') +
          row('Default zoom', m.zoom != null ? code(m.zoom) : '—') +
          row('Extent', m.extent ? code(JSON.stringify(m.extent)) : '—') +
        '</dl></div>' +

      '<div class="ac-card"><div class="ac-card-head"><h2 class="ac-card-title">Endpoints</h2></div>' +
        '<dl class="ac-grid">' +
          row('Map Buddy AI', ep.mapBuddy ? code(ep.mapBuddy) : '—') +
        '</dl></div>' +

      '<div class="ac-card"><div class="ac-card-head"><h2 class="ac-card-title">Reference lookups</h2>' +
        '<span class="ac-card-note">code → name maps shared by the popup &amp; explainers</span></div>' +
        '<dl class="ac-grid">' +
          '<dt>Property classes</dt><dd>' + Object.keys(propClass).length + ' codes ' +
            '<button class="ac-lookup-toggle" data-lookup="propClass">View</button></dd>' +
          '<dt>School districts</dt><dd>' + Object.keys(schoolDist).length + ' codes ' +
            '<button class="ac-lookup-toggle" data-lookup="schoolDist">View</button></dd>' +
        '</dl><div id="ac-lookup-out"></div></div>';

    host.innerHTML = html;

    var maps = { propClass: propClass, schoolDist: schoolDist };
    var out = host.querySelector('#ac-lookup-out');
    var shown = null;
    host.querySelectorAll('[data-lookup]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var key = btn.getAttribute('data-lookup');
        if (shown === key) { out.innerHTML = ''; shown = null; host.querySelectorAll('[data-lookup]').forEach(function (b) { b.textContent = 'View'; }); return; }
        shown = key;
        host.querySelectorAll('[data-lookup]').forEach(function (b) { b.textContent = b === btn ? 'Hide' : 'View'; });
        var rows = Object.keys(maps[key]).sort().map(function (k) {
          return '<tr><td>' + esc(k) + '</td><td>' + esc(maps[key][k]) + '</td></tr>';
        }).join('');
        out.innerHTML = '<table class="ac-table"><thead><tr><th>Code</th><th>Name</th></tr></thead><tbody>' + rows + '</tbody></table>';
      });
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

  // ── Module registry ─────────────────────────────────────────────────────────
  var MODULES = [
    { id: 'county', label: 'County Configuration', icon: '◆', render: renderCounty },
    { id: 'styling', label: 'Styling', icon: '◑', soon: true,
      render: roadmap('Styling', 'Parcel & label styling, choropleth, themes — moved out of hardcoded JS/CSS into editable config.', 'DIC-460',
        ['Parcel fill/stroke + choropleth by class or AV/TV bands', 'Label field, sizing & zoom thresholds', 'Basemap, light/dark defaults, color-scheme presets', 'Live preview against a sandboxed viewer']) },
    { id: 'intelligence', label: 'Intelligence', icon: '✦', soon: true,
      render: roadmap('Intelligence', 'Explainer profiles, AI models, feature flags & search — built on the EXPLAINER_PROFILES seam already shipping.', 'DIC-459',
        ['Explainer profiles: editable prompt + injected context blocks + model', 'Per-feature model selection, API keys & rate limits', 'Map Buddy on/off feature flags', 'Search fields & relevance weighting']) },
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

    var initial = (location.hash || '').replace('#', '');
    show(MODULES.some(function (m) { return m.id === initial; }) ? initial : 'county');

    // Reflect the live county name in the switcher.
    var sel = document.getElementById('ac-county-select');
    if (sel && window.COUNTY && window.COUNTY.name) sel.options[0].textContent = window.COUNTY.name;
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
}());
