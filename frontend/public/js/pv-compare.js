/**
 * pv-compare.js — Compare preset of the cohort-analyze capability (DIC-589).
 *
 * "Compare parcels" expressed over the cohort capability: the EXPLICIT cohort selector
 * (2–5 hand-picked parcels via /cohort) + a side-by-side / diff presentation. The
 * deterministic transpose + diff is the engine core's `compare` aggregator
 * (ISV_COHORT_ANALYZE_CORE) — this module is just the viewer surface: a compare TRAY to
 * build the set, and a table panel that renders the core's facts with row-level diff
 * highlighting. No AI (a deterministic capability); capability-gated 'compare' (default-on).
 *
 * Exposes: window.PV_COMPARE { add, addCurrent, remove, clear, open, show, has, isEnabled }.
 */
(function (root) {
  'use strict';
  var doc = root.document;
  var MAX = 5, MIN = 2;
  var _set = [];   // [{ id, pin }]

  function apiBase() { return root.API_BASE || (root.PS_CONFIG && root.PS_CONFIG.API_BASE) || '/api'; }
  function caps() { return root.PV_CAPS || null; }
  function enabled() { var c = caps(); return c ? c.isEnabled('compare') : true; }
  function core() { return root.ISV_COHORT_ANALYZE_CORE || null; }
  function cfg() { return (root.PS_CONTEXT && root.PS_CONTEXT.config) || root.COUNTY || {}; }
  function labelMap(k) { var l = cfg().labels || {}; return l[k] || {}; }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function el(id) { return doc && doc.getElementById(id); }

  // ── The fields shown as comparison rows (config; formatter resolved per `fmt`) ──
  var COMPARE_FIELDS = [
    { key: 'pin', label: 'Parcel ID' },
    { key: 'PCOMBINED', label: 'Address' },
    { key: 'owner_name', label: 'Owner' },
    { key: 'prop_class', label: 'Class', fmt: 'class' },
    { key: 'gis_acres', label: 'Acres', fmt: 'acres' },
    { key: 'assessed_value', label: 'Assessed Value', fmt: 'money' },
    { key: 'taxable_value', label: 'Taxable Value', fmt: 'money' },
    { key: 'av_per_acre', label: 'Assessed $/acre', fmt: 'money' },
    { key: 'school_dist', label: 'School District', fmt: 'school' },
  ];
  var FMT_BY_KEY = {};
  COMPARE_FIELDS.forEach(function (f) { FMT_BY_KEY[f.key] = f.fmt || 'text'; });

  function fmtVal(key, v) {
    if (v == null || v === '') return '—';
    switch (FMT_BY_KEY[key]) {
      case 'money': { var n = Number(v); return isNaN(n) ? esc(v) : '$' + Math.round(n).toLocaleString(); }
      case 'acres': { var a = Number(v); return isNaN(a) ? esc(v) : a.toFixed(2) + ' ac'; }
      case 'class': { var c = String(v).trim(); var nm = labelMap('propClass')[c]; return esc(nm ? (c + ' – ' + nm) : c); }
      case 'school': { var s = String(v).trim(); return esc(labelMap('schoolDist')[s] || s); }
      default: return esc(v);
    }
  }

  // ── Compare TRAY (build the set) ────────────────────────────────────────────
  function ensureTray() {
    var tray = el('pv-compare-tray');
    if (!tray) {
      tray = doc.createElement('div');
      tray.id = 'pv-compare-tray';
      tray.className = 'pv-compare-tray';
      tray.hidden = true;
      tray.innerHTML =
        '<span class="pv-compare-tray-label">Compare</span>' +
        '<span id="pv-compare-chips" class="pv-compare-chips"></span>' +
        '<button type="button" id="pv-compare-go" class="pv-compare-go">Compare</button>' +
        '<button type="button" id="pv-compare-clear" class="pv-compare-clear" aria-label="Clear comparison">Clear</button>';
      (doc.body || doc.documentElement).appendChild(tray);
      el('pv-compare-go').addEventListener('click', show);
      el('pv-compare-clear').addEventListener('click', clear);
    }
    return tray;
  }

  function renderTray() {
    if (!doc) return;
    var tray = ensureTray();
    if (!_set.length) { tray.hidden = true; return; }
    tray.hidden = false;
    var chips = el('pv-compare-chips');
    chips.innerHTML = _set.map(function (p) {
      return '<span class="pv-compare-chip" data-id="' + esc(p.id) + '">' + esc(p.pin || p.id) +
        '<button type="button" class="pv-compare-chip-x" data-id="' + esc(p.id) + '" aria-label="Remove">×</button></span>';
    }).join('');
    [].forEach.call(chips.querySelectorAll('.pv-compare-chip-x'), function (b) {
      b.addEventListener('click', function () { remove(b.getAttribute('data-id')); });
    });
    var go = el('pv-compare-go');
    go.disabled = _set.length < MIN;
    go.textContent = 'Compare' + (_set.length >= MIN ? ' (' + _set.length + ')' : '');
  }

  function has(id) { return _set.some(function (p) { return String(p.id) === String(id); }); }
  function add(id, pin) {
    if (!enabled() || id == null) return;
    if (has(id)) { renderTray(); return; }
    if (_set.length >= MAX) { toast('Compare holds up to ' + MAX + ' parcels.'); return; }
    _set.push({ id: id, pin: pin || null });
    renderTray();
  }
  function addCurrent() {
    var pc = root.PS_STATE && root.PS_STATE.parcel;
    if (!pc || pc.id == null) { toast('Select a parcel first, then add it to Compare.'); return; }
    add(pc.id, pc.pin);
    if (_set.length < MIN) toast('Added ' + (pc.pin || pc.id) + ' — pick another parcel to compare.');
  }
  function remove(id) { _set = _set.filter(function (p) { return String(p.id) !== String(id); }); renderTray(); }
  function clear() { _set = []; renderTray(); }

  // ── Compare TABLE (render the core's facts) ─────────────────────────────────
  // For Map Buddy / programmatic: set the cohort to these parcels, then show. Each entry
  // may be a numeric id, a PIN string, or { id, pin } (e.g. Map Buddy passes PINs).
  function normItem(x) {
    if (x && typeof x === 'object') return { id: x.id != null ? x.id : null, pin: x.pin || null };
    if (typeof x === 'number') return { id: x, pin: null };
    var s = String(x).trim();
    return /^\d+$/.test(s) ? { id: Number(s), pin: null } : { id: null, pin: s };
  }
  function open(list) {
    if (Array.isArray(list)) { _set = list.slice(0, MAX).map(normItem); }
    renderTray();
    show();
  }

  function show() {
    if (!enabled()) return;
    if (_set.length < MIN) { toast('Add at least ' + MIN + ' parcels to compare.'); return; }
    var ids = [], pins = [];
    _set.forEach(function (p) { if (p.id != null) ids.push(p.id); else if (p.pin) pins.push(p.pin); });
    var selector = { type: 'explicit' };
    if (ids.length) selector.ids = ids;
    if (pins.length) selector.pins = pins;
    fetch(apiBase() + '/cohort', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ selector: selector }),
    })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (!data || !data.features || !data.features.length) { toast('Couldn’t load those parcels.'); return; }
        renderTable(data);
      })
      .catch(function () { toast('Couldn’t reach the server to compare.'); });
  }

  function renderTable(data) {
    var eng = core();
    // Inject the computed $/acre so it compares like any other field (kept out of the
    // pure core — it's a presentation-derived field).
    var feats = data.features.map(function (f) {
      var p = f.properties || {};
      var av = Number(p.assessed_value), ac = Number(p.gis_acres);
      var perAcre = (!isNaN(av) && !isNaN(ac) && ac > 0) ? Math.round(av / ac) : null;
      return { id: f.id, properties: Object.assign({}, p, { av_per_acre: perAcre }) };
    });
    var result = eng.core({
      cohort: { selector: data.selector, features: feats },
      fields: { columnLabel: 'pin', compareFields: COMPARE_FIELDS.map(function (f) { return { key: f.key, label: f.label }; }) },
      aggregators: ['compare'], source_id: 'assessment-roll',
    });
    var t = result.facts.compare;

    var head = '<th class="pv-cmp-fieldhead">Field</th>' + t.columns.map(function (col) {
      return '<th>' + esc(col.label || col.id) +
        '<button type="button" class="pv-cmp-colx" data-id="' + esc(col.id) + '" aria-label="Remove from comparison">×</button></th>';
    }).join('');
    var body = t.rows.map(function (row) {
      var cells = row.values.map(function (v) { return '<td>' + fmtVal(row.field, v) + '</td>'; }).join('');
      return '<tr class="' + (row.differs ? 'pv-cmp-differs' : '') + '"><th scope="row">' + esc(row.label) +
        (row.differs ? ' <span class="pv-cmp-diffdot" title="values differ" aria-label="values differ"></span>' : '') +
        '</th>' + cells + '</tr>';
    }).join('');

    var overlay = el('pv-compare-overlay') || (function () {
      var o = doc.createElement('div'); o.id = 'pv-compare-overlay'; o.className = 'pv-compare-overlay';
      (doc.body || doc.documentElement).appendChild(o);
      o.addEventListener('click', function (e) { if (e.target === o) closeOverlay(); });
      return o;
    })();
    overlay.innerHTML =
      '<div class="pv-compare-modal" role="dialog" aria-modal="true" aria-label="Compare parcels">' +
        '<div class="pv-compare-modal-head">' +
          '<h2 class="pv-compare-modal-title">Compare Parcels</h2>' +
          '<button type="button" class="pv-compare-modal-x" aria-label="Close">×</button>' +
        '</div>' +
        '<div class="pv-compare-modal-body">' +
          '<table class="pv-compare-table"><thead><tr>' + head + '</tr></thead><tbody>' + body + '</tbody></table>' +
          '<p class="pv-compare-note">Differing rows are highlighted. Derived from the assessment roll — not an official valuation.</p>' +
        '</div>' +
      '</div>';
    overlay.hidden = false;
    overlay.querySelector('.pv-compare-modal-x').addEventListener('click', closeOverlay);
    // Removing a column from inside the table updates the set and re-renders (or closes).
    [].forEach.call(overlay.querySelectorAll('.pv-cmp-colx'), function (b) {
      b.addEventListener('click', function () {
        remove(b.getAttribute('data-id'));
        if (_set.length >= MIN) show(); else closeOverlay();
      });
    });
  }

  function closeOverlay() { var o = el('pv-compare-overlay'); if (o) o.hidden = true; }

  // Reuse the AI-mode toast styling for transient hints.
  function toast(msg) {
    if (!doc) return;
    var t = doc.createElement('div'); t.className = 'pv-toast'; t.setAttribute('role', 'status'); t.textContent = msg;
    (doc.body || doc.documentElement).appendChild(t);
    if (root.requestAnimationFrame) root.requestAnimationFrame(function () { t.classList.add('pv-toast--show'); });
    else t.classList.add('pv-toast--show');
    if (root.setTimeout) root.setTimeout(function () {
      t.classList.remove('pv-toast--show');
      root.setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 320);
    }, 2600);
  }

  root.PV_COMPARE = {
    add: add, addCurrent: addCurrent, remove: remove, clear: clear,
    open: open, show: show, has: has, isEnabled: enabled,
  };
}(typeof self !== 'undefined' ? self : this));
