/**
 * pv-profile.js — Neighborhood / Area Profile, the flagship cohort-analyze preset (DIC-588).
 *
 * Pick an area (a buffer around the selected parcel, via /cohort) → a rich, auditable
 * profile of its composition, character, and values, assembled from the engine core's
 * aggregators (ISV_COHORT_ANALYZE_CORE: composition / value-stats / value-change /
 * ownership / area-distribution). Deterministic — the dashboard stands alone (facts-parity).
 *
 * AI "character" read (DIC-588): when AI is on + reachable, an additive card at the top
 * narrates "what kind of neighborhood is this" over the SAME deterministic facts, via the
 * cohort-analyze narrate seam (map-buddy POST /describe-cohort, fetchCohortNarration). The
 * model never originates a number (grounding-judge gated, DIC-586); AI off/unreachable →
 * no card, the dashboard stands alone (§4.5/§4.6 degrade-to-facts). Capability-gated
 * 'profile' (default-on).
 *
 * Exposes: window.PV_PROFILE { open, close, isEnabled }.
 *   open({ parcelId?, distanceFt? })  — defaults to the selected parcel + 1320 ft (¼ mile).
 */
(function (root) {
  'use strict';
  var doc = root.document;
  var RADII = [500, 1320, 2640];       // ft preset options (¼ mi = 1320, ½ mi = 2640)
  var DEFAULT_FT = 1320;
  var MIN_FT = 100, MAX_FT = 10560;    // custom-distance clamp (≈ up to 2 mi)
  // Area modes: a buffer around the parcel (default) or a named geography (DIC-588).
  // The geography keys match the backend GEOGRAPHY_SOURCES whitelist + /cohort/geographies.
  var AREA_MODES = [
    { key: 'buffer', label: 'Around this parcel' },
    { key: 'subdivision', label: 'Subdivision' },
    { key: 'section', label: 'Section' },
    { key: 'township', label: 'Township' },
    { key: 'school', label: 'School district' },
  ];

  function apiBase() { return root.API_BASE || (root.PS_CONFIG && root.PS_CONFIG.API_BASE) || '/api'; }
  function caps() { return root.PV_CAPS || null; }
  function enabled() { var c = caps(); return c ? c.isEnabled('profile') : true; }
  function core() { return root.ISV_COHORT_ANALYZE_CORE || null; }
  function cfg() { return (root.PS_CONTEXT && root.PS_CONTEXT.config) || root.COUNTY || {}; }
  function modeLabel(key) { for (var i = 0; i < AREA_MODES.length; i++) { if (AREA_MODES[i].key === key) return AREA_MODES[i].label; } return key; }
  function ftLabel(ft) { return ft >= 5280 ? (ft / 5280) + ' mi' : (ft === 1320 ? '¼ mi' : (ft === 2640 ? '½ mi' : ft + ' ft')); }

  // ── AI character narration (DIC-588 / cohort-analyze narrate seam) ───────────
  // Resolve the Map Buddy base the same way pv-explain does (one service, one key).
  function mapBuddyBase() {
    var isLocal = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
    var endpoints = cfg().endpoints || {};
    return root.MAP_BUDDY_API || endpoints.mapBuddy ||
      (isLocal && '/map-buddy-api') ||
      'https://map-buddy-toaozre74a-uc.a.run.app';
  }
  // AI on AND reachable (mirrors pv-explain.aiEnabled): the controller short-circuits a
  // known-down service so we degrade to the dashboard immediately rather than per-request.
  function aiEnabled() {
    if (root.PV_AI_MODE && typeof root.PV_AI_MODE.isEffective === 'function') return root.PV_AI_MODE.isEffective();
    if (root.PV_PREFS && typeof root.PV_PREFS.getAiMode === 'function') return root.PV_PREFS.getAiMode() === 'on';
    var pref = root.PV_PREFS && root.PV_PREFS.aiMode;
    return !(pref === 'off' || pref === false);
  }
  // Available named geographies of a type (DIC-588), cached per type. [] on failure.
  var _geoCache = {};
  function fetchGeographies(type) {
    if (_geoCache[type]) return _geoCache[type];
    _geoCache[type] = fetch(apiBase() + '/cohort/geographies?type=' + encodeURIComponent(type), { cache: 'force-cache' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { return (j && j.geographies) || []; })
      .catch(function () { return []; });
    return _geoCache[type];
  }

  // The narrate transport (ctx.fetchCohortNarration shape): POST the deterministic facts,
  // get back a character read. Returns null on ANY failure → caller shows no card (§4.5).
  function fetchCohortNarration(facts) {
    return fetch(mapBuddyBase() + '/describe-cohort', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ facts: facts }),
    })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (res) { return (res && res.ok && res.narration) ? res.narration : null; })
      .catch(function () { return null; });
  }
  function labelMap(k) { var l = cfg().labels || {}; return l[k] || {}; }
  function el(id) { return doc && doc.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function money(v) { var n = Number(v); return (v == null || isNaN(n)) ? '—' : '$' + Math.round(n).toLocaleString(); }
  function acres(v) { var n = Number(v); return (v == null || isNaN(n)) ? '—' : n.toFixed(1) + ' ac'; }
  function pct(v) { return (v == null) ? '—' : (v >= 0 ? '+' : '') + (v * 100).toFixed(1) + '%'; }
  function classLabel(code) { var c = String(code == null ? '' : code).trim(); var nm = labelMap('propClass')[c]; return nm ? (c + ' – ' + nm) : (c || '(none)'); }

  var PROFILE_FIELDS = {
    area: 'gis_acres', category: 'prop_class', owner: 'owner_name',
    values: [
      { key: 'assessed_value', prev: 'prev_assessed_value', label: 'Assessed Value' },
      { key: 'taxable_value', prev: 'prev_taxable_value', label: 'Taxable Value' },
    ],
  };
  var AGGS = ['composition', 'value-stats', 'value-change', 'ownership', 'area-distribution'];

  var _ctx = { parcelId: null, mode: 'buffer', distanceFt: DEFAULT_FT, geoName: null, geoId: null };

  // Build the /cohort selector for the current area mode. Buffer needs a parcel; a named
  // geography needs a chosen name/id. Returns null when the mode isn't satisfiable yet.
  function buildSelector() {
    if (_ctx.mode === 'buffer') {
      if (_ctx.parcelId == null) return null;
      return { type: 'buffer', parcel_id: _ctx.parcelId, distance_ft: _ctx.distanceFt };
    }
    if (_ctx.geoName == null && _ctx.geoId == null) return null;
    var sel = { type: 'named-geography', geography: _ctx.mode };
    if (_ctx.geoId != null) sel.id = _ctx.geoId; else sel.name = _ctx.geoName;
    return sel;
  }

  function open(opts) {
    if (!enabled()) return;
    opts = opts || {};
    if (opts.mode) _ctx.mode = opts.mode;
    if (opts.geoName !== undefined) _ctx.geoName = opts.geoName;
    if (opts.geoId !== undefined) _ctx.geoId = opts.geoId;
    if (opts.distanceFt) _ctx.distanceFt = opts.distanceFt;
    var pid = opts.parcelId;
    if (pid == null) { var pc = root.PS_STATE && root.PS_STATE.parcel; pid = pc && pc.id; }
    if (pid != null) _ctx.parcelId = pid;
    // Buffer mode needs a parcel to anchor; named-geography can stand on its own.
    if (_ctx.mode === 'buffer' && _ctx.parcelId == null) {
      return hint('Select a parcel first, then open the Neighborhood Profile.');
    }
    var selector = buildSelector();
    renderShell('Loading neighborhood…');
    if (!selector) { renderBody('<p class="pv-prof-empty">Pick a ' + esc(modeLabel(_ctx.mode).toLowerCase()) + ' above to profile it.</p>'); return; }
    fetch(apiBase() + '/cohort', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ selector: selector }),
    })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (!data || !data.features || !data.features.length) { renderBody('<p class="pv-prof-empty">No parcels found in this area.</p>', data && data.selector); return; }
        var result = core().core({
          cohort: { selector: data.selector, features: data.features },
          fields: PROFILE_FIELDS, aggregators: AGGS, source_id: 'assessment-roll',
        });
        renderBody(dashboard(result.facts), data.selector);
        maybeNarrate(result.facts);   // additive AI character read; degrades to no-op
      })
      .catch(function () { renderBody('<p class="pv-prof-empty">Couldn’t reach the server.</p>'); });
  }

  // ── Dashboard sections (from the deterministic facts) ───────────────────────
  function dashboard(f) {
    return [
      overviewCard(f), compositionCard(f), valuesCard(f), changeCard(f), ownershipCard(f), sizeCard(f),
    ].join('') +
      '<p class="pv-prof-note">Derived from the assessment roll — educational summary, not an official valuation. Every figure aggregates the parcels in the selected area.</p>';
  }

  function card(title, inner) { return '<section class="pv-prof-card"><h3 class="pv-prof-card-t">' + esc(title) + '</h3>' + inner + '</section>'; }
  function stat(label, value) { return '<div class="pv-prof-stat"><span class="pv-prof-stat-v">' + value + '</span><span class="pv-prof-stat-l">' + esc(label) + '</span></div>'; }

  function overviewCard(f) {
    var c = f.composition || {}; var a = c.area || {};
    return card('Overview', '<div class="pv-prof-stats">' +
      stat('parcels', (c.count != null ? c.count : '—')) +
      stat('total acres', acres(a.sum)) +
      stat('median lot', acres(a.median)) + '</div>');
  }

  function bars(items, labelFn, max) {
    return '<div class="pv-prof-bars">' + items.map(function (it) {
      var w = max ? Math.round((it.count / max) * 100) : 0;
      return '<div class="pv-prof-bar-row"><span class="pv-prof-bar-l">' + esc(labelFn(it)) + '</span>' +
        '<span class="pv-prof-bar-track"><span class="pv-prof-bar-fill" style="width:' + w + '%"></span></span>' +
        '<span class="pv-prof-bar-n">' + it.count + (it.share != null ? ' · ' + Math.round(it.share * 100) + '%' : '') + '</span></div>';
    }).join('') + '</div>';
  }

  function compositionCard(f) {
    var mix = (f.composition && f.composition.categoryMix) || [];
    if (!mix.length) return '';
    var top = mix.slice(0, 6), max = top[0].count;
    return card('Composition (class mix)', bars(top, function (e) { return classLabel(e.key); }, max));
  }

  function valuesCard(f) {
    var v = f.valueStats || {}; var av = v.assessed_value || {}; var tv = v.taxable_value || {};
    return card('Values (assessment)', '<div class="pv-prof-stats">' +
      stat('median AV', money(av.median)) +
      stat('mean AV', money(av.mean)) +
      stat('AV $/acre', money(av.perArea)) +
      stat('median TV', money(tv.median)) +
      stat('AV range', money(av.min) + ' – ' + money(av.max)) + '</div>');
  }

  function changeCard(f) {
    var vc = (f.valueChange && f.valueChange.assessed_value) || null;
    if (!vc) return '';
    var dir = vc.deltaPct > 0 ? 'up' : (vc.deltaPct < 0 ? 'down' : 'flat');
    return card('Year-over-year (assessed)', '<div class="pv-prof-stats">' +
      stat('change', '<span class="pv-prof-delta-' + dir + '">' + pct(vc.deltaPct) + '</span>') +
      stat('rose', vc.up) + stat('fell', vc.down) + stat('unchanged', vc.flat) + '</div>');
  }

  function ownershipCard(f) {
    var o = f.ownership || {};
    var top = o.topOwner || {};
    return card('Ownership', '<div class="pv-prof-stats">' +
      stat('distinct owners', (o.distinctOwners != null ? o.distinctOwners : '—')) +
      stat('top owner share', (top.share != null ? Math.round(top.share * 100) + '%' : '—')) +
      stat('owners w/ 2+', (o.multiFeatureOwners != null ? o.multiFeatureOwners : '—')) +
      stat('concentration', (o.concentrationHHI != null ? o.concentrationHHI.toFixed(2) : '—')) +
      (o.unknownCount ? stat('unmatched', o.unknownCount) : '') + '</div>' +
      (o.unknownCount ? '<p class="pv-prof-subnote">Shares are over the ' + ((o.total || 0) - o.unknownCount) + ' parcels with a named owner; ' + o.unknownCount + ' have no owner on record.</p>' : ''));
  }

  function sizeCard(f) {
    var d = f.areaDistribution || {}; var buckets = d.buckets || [];
    if (!buckets.length) return '';
    var max = buckets.reduce(function (m, b) { return Math.max(m, b.count); }, 0) || 1;
    return card('Parcel size (acres)', bars(buckets, function (b) { return b.label; }, max));
  }

  // ── AI character card (additive over the deterministic dashboard) ───────────
  // Loads asynchronously AFTER the dashboard so the facts are never gated on the model.
  // AI off → skip entirely; AI on → a subtle loading card that becomes the read, or
  // removes itself on failure (degrade-to-facts: the dashboard always stands alone).
  function maybeNarrate(facts) {
    if (!aiEnabled()) return;
    // Guard against a stale response after the user changes area/radius mid-flight.
    var token = [_ctx.mode, _ctx.parcelId, _ctx.distanceFt, _ctx.geoId, _ctx.geoName].join(':');
    _ctx.narrateToken = token;
    var body = el('pv-profile-body');
    if (!body) return;
    body.insertAdjacentHTML('afterbegin', aiLoadingHtml());
    fetchCohortNarration(facts).then(function (n) {
      if (_ctx.narrateToken !== token) return;   // user moved on; drop this result
      var slot = el('pv-prof-ai');
      if (!slot) return;
      if (n && (n.headline || (n.paragraphs && n.paragraphs.length))) slot.outerHTML = aiCardHtml(n);
      else if (slot.parentNode) slot.parentNode.removeChild(slot);   // no card on failure
    });
  }

  function aiLoadingHtml() {
    return '<section id="pv-prof-ai" class="pv-prof-card pv-prof-ai pv-prof-ai-loading">' +
      '<span class="pv-prof-ai-spark" aria-hidden="true">✦</span>' +
      '<span class="pv-prof-ai-loadtext">Reading the neighborhood…</span></section>';
  }

  function aiCardHtml(n) {
    var paras = (n.paragraphs || []).map(function (p) { return '<p>' + esc(p) + '</p>'; }).join('');
    var caveats = (n.caveats && n.caveats.length)
      ? '<p class="pv-prof-ai-caveat">' + n.caveats.map(esc).join(' ') + '</p>' : '';
    return '<section id="pv-prof-ai" class="pv-prof-card pv-prof-ai">' +
      '<div class="pv-prof-ai-head"><span class="pv-prof-ai-spark" aria-hidden="true">✦</span>' +
        '<div><h3 class="pv-prof-ai-title">' + esc(n.headline || 'Neighborhood character') + '</h3>' +
        (n.character ? '<div class="pv-prof-ai-tag">' + esc(n.character) + '</div>' : '') + '</div></div>' +
      '<div class="pv-prof-ai-body">' + paras + caveats + '</div>' +
      '<p class="pv-prof-ai-note">AI summary of the figures below — not an official valuation.</p>' +
      '</section>';
  }

  // ── Shell / overlay ─────────────────────────────────────────────────────────
  function renderShell(loading) {
    var overlay = el('pv-profile-overlay') || (function () {
      var o = doc.createElement('div'); o.id = 'pv-profile-overlay'; o.className = 'pv-profile-overlay';
      (doc.body || doc.documentElement).appendChild(o);
      o.addEventListener('click', function (e) { if (e.target === o) close(); });
      return o;
    })();
    overlay.innerHTML =
      '<div class="pv-profile-modal" role="dialog" aria-modal="true" aria-label="Neighborhood profile">' +
        '<div class="pv-profile-head">' +
          '<div class="pv-profile-head-l"><h2 class="pv-profile-title">Neighborhood Profile</h2>' +
            '<div id="pv-profile-sub" class="pv-profile-sub">' + esc(loading || '') + '</div>' +
            controlsHtml() + '</div>' +
          '<button type="button" class="pv-profile-x" aria-label="Close">×</button>' +
        '</div>' +
        '<div id="pv-profile-body" class="pv-profile-body">' + (loading ? '<p class="pv-prof-empty">' + esc(loading) + '</p>' : '') + '</div>' +
      '</div>';
    overlay.hidden = false;
    overlay.querySelector('.pv-profile-x').addEventListener('click', close);
    wireControls(overlay);
  }

  // Area + size controls: an area-mode picker plus mode-specific sizing (radius chips +
  // a custom-distance field for buffers; a name dropdown for a named geography).
  function controlsHtml() {
    var modeOpts = AREA_MODES.map(function (m) {
      return '<option value="' + m.key + '"' + (m.key === _ctx.mode ? ' selected' : '') + '>' + esc(m.label) + '</option>';
    }).join('');
    return '<div class="pv-prof-controls">' +
      '<label class="pv-prof-ctl"><span class="pv-prof-ctl-l">Area</span>' +
        '<select id="pv-prof-mode" class="pv-prof-select" aria-label="Area type">' + modeOpts + '</select></label>' +
      '<span id="pv-prof-mode-ctl" class="pv-prof-mode-ctl">' + modeControlsHtml() + '</span>' +
      '</div>';
  }

  function modeControlsHtml() {
    if (_ctx.mode === 'buffer') {
      var radii = RADII.map(function (ft) {
        return '<button type="button" class="pv-prof-radius' + (ft === _ctx.distanceFt ? ' is-on' : '') +
          '" data-ft="' + ft + '">' + ftLabel(ft) + '</button>';
      }).join('');
      var customVal = RADII.indexOf(_ctx.distanceFt) < 0 ? _ctx.distanceFt : '';
      return '<span class="pv-prof-radii">' + radii + '</span>' +
        '<span class="pv-prof-custom"><input id="pv-prof-custom-ft" class="pv-prof-custom-in" type="number" ' +
          'min="' + MIN_FT + '" max="' + MAX_FT + '" step="10" placeholder="ft" aria-label="Custom distance in feet"' +
          (customVal ? ' value="' + customVal + '"' : '') + '><span class="pv-prof-custom-u">ft</span></span>';
    }
    // named geography: a name dropdown (lazy-filled by wireControls).
    return '<select id="pv-prof-geo" class="pv-prof-select pv-prof-geo-select" aria-label="' + esc(modeLabel(_ctx.mode)) + '">' +
      '<option value="">Loading ' + esc(modeLabel(_ctx.mode).toLowerCase()) + 's…</option></select>';
  }

  function wireControls(overlay) {
    var modeSel = overlay.querySelector('#pv-prof-mode');
    if (modeSel) modeSel.addEventListener('change', function () {
      _ctx.mode = modeSel.value; _ctx.geoName = null; _ctx.geoId = null;
      open({});   // re-render controls; named modes show "pick one" until a name is chosen
    });
    [].forEach.call(overlay.querySelectorAll('.pv-prof-radius'), function (b) {
      b.addEventListener('click', function () { open({ distanceFt: parseInt(b.getAttribute('data-ft'), 10) }); });
    });
    var custom = overlay.querySelector('#pv-prof-custom-ft');
    if (custom) custom.addEventListener('change', function () {
      var ft = Math.max(MIN_FT, Math.min(MAX_FT, parseInt(custom.value, 10) || 0));
      if (ft) open({ distanceFt: ft });
    });
    var geoSel = overlay.querySelector('#pv-prof-geo');
    if (geoSel) {
      fetchGeographies(_ctx.mode).then(function (list) {
        var cur = el('pv-prof-geo'); if (!cur) return;   // shell may have been re-rendered
        if (!list.length) { cur.innerHTML = '<option value="">none available</option>'; return; }
        var schoolMap = _ctx.mode === 'school' ? labelMap('schoolDist') : null;
        cur.innerHTML = '<option value="">Choose a ' + esc(modeLabel(_ctx.mode).toLowerCase()) + '…</option>' +
          list.map(function (g) {
            var v = g.id != null ? ('id:' + g.id) : ('name:' + g.name);
            var seld = (g.id != null && g.id === _ctx.geoId) || (g.id == null && g.name === _ctx.geoName);
            // School districts are stored as codes — show the readable name when the county map has it.
            var text = (schoolMap && schoolMap[g.name]) ? (schoolMap[g.name] + ' (' + g.name + ')') : g.name;
            return '<option value="' + esc(v) + '"' + (seld ? ' selected' : '') + '>' + esc(text) + '</option>';
          }).join('');
      });
      geoSel.addEventListener('change', function () {
        var v = geoSel.value;
        if (!v) return;
        if (v.indexOf('id:') === 0) open({ geoId: parseInt(v.slice(3), 10), geoName: null });
        else open({ geoName: v.slice(5), geoId: null });
      });
    }
  }

  function renderBody(html, selector) {
    var body = el('pv-profile-body'); if (body) body.innerHTML = html;
    var sub = el('pv-profile-sub');
    if (sub) sub.textContent = selector ? (selector.label + ' — ' + (selector.count || 0) + ' parcels') : '';
  }

  function close() { var o = el('pv-profile-overlay'); if (o) o.hidden = true; }

  function hint(msg) {
    if (!doc) return;
    var t = doc.createElement('div'); t.className = 'pv-toast'; t.setAttribute('role', 'status'); t.textContent = msg;
    (doc.body || doc.documentElement).appendChild(t);
    if (root.requestAnimationFrame) root.requestAnimationFrame(function () { t.classList.add('pv-toast--show'); });
    else t.classList.add('pv-toast--show');
    if (root.setTimeout) root.setTimeout(function () { t.classList.remove('pv-toast--show'); root.setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 320); }, 2600);
  }

  root.PV_PROFILE = { open: open, close: close, isEnabled: enabled };
}(typeof self !== 'undefined' ? self : this));
