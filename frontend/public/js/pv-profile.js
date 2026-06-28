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
    { key: 'drawn', label: 'Draw an area' },
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

  // ── Environmental context (center-point read; DIC-588) ──────────────────────
  // A true area clip (% acreage in wetland/flood) needs the env layers in PostGIS; today
  // they're WMS-only (FEMA NFHL / USFWS NWI / USDA SSURGO point services). So we sample the
  // AREA'S CENTER (one read each, via the same /wms-proxy the popup uses) for a coarse,
  // clearly-labeled read. When wetlands become a county overlay and per-feature acreage is
  // clipped into the cohort, the deterministic core 'environmental' aggregator takes over
  // automatically (see envCard's two paths). Cached per rounded center.
  var _FEMA_NFHL = 'https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28/query';
  var _NWI = 'https://fwspublicservices.wim.usgs.gov/wetlandsmapservice/rest/services/Wetlands/MapServer/0/query';
  var _SSURGO = 'https://sdmdataaccess.nrcs.usda.gov/Spatial/SDM.wms';
  function wmsProxy(url) { return apiBase() + '/wms-proxy?url=' + encodeURIComponent(url); }

  function _restPoint(base, lng, lat) {
    var url = base + '?geometry=' + lng + '%2C' + lat + '&geometryType=esriGeometryPoint&inSR=4326' +
      '&spatialRel=esriSpatialRelIntersects&outFields=*&returnGeometry=false&f=json';
    return fetch(wmsProxy(url)).then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        var f = d && d.features && d.features[0]; if (!f) return null;
        var raw = f.attributes || {}, out = {};
        Object.keys(raw).forEach(function (k) { out[k.indexOf('.') !== -1 ? k.split('.').pop() : k] = raw[k]; });
        return out;
      }).catch(function () { return null; });
  }
  function _soilAt(lng, lat) {
    var R = 6378137.0, mx = lng * Math.PI * R / 180.0;
    var my = Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360.0)) * R, half = 150.0;
    var url = _SSURGO + '?SERVICE=WMS&VERSION=1.1.1&REQUEST=GetFeatureInfo&LAYERS=MapunitPolyExtended' +
      '&QUERY_LAYERS=MapunitPolyExtended&BBOX=' + (mx - half) + ',' + (my - half) + ',' + (mx + half) + ',' + (my + half) +
      '&WIDTH=256&HEIGHT=256&X=128&Y=128&SRS=EPSG:3857&INFO_FORMAT=text/plain&FEATURE_COUNT=3';
    return fetch(wmsProxy(url)).then(function (r) { return r.ok ? r.text() : ''; })
      .then(function (t) {
        var name = null; (t || '').split('\n').forEach(function (ln) {
          var i = ln.indexOf('='); if (i < 0) return;
          var k = ln.slice(0, i).trim().toLowerCase(), v = ln.slice(i + 1).trim().replace(/^['"]|['"]$/g, '');
          if (k === 'muname' && v && !name) name = v;
        });
        return name;
      }).catch(function () { return null; });
  }
  var _envCache = {};
  function envAtPoint(center) {
    if (!center || center.length < 2) return Promise.resolve(null);
    var key = center[0].toFixed(4) + ',' + center[1].toFixed(4);
    if (_envCache[key]) return _envCache[key];
    var lng = center[0], lat = center[1];
    _envCache[key] = Promise.all([_restPoint(_FEMA_NFHL, lng, lat), _restPoint(_NWI, lng, lat), _soilAt(lng, lat)])
      .then(function (r) {
        var fl = r[0], we = r[1];
        return {
          flood: fl ? { zone: fl.FLD_ZONE, sfha: fl.SFHA_TF } : { zone: 'X', none: true },
          wetlands: we ? { present: true, type: we.WETLAND_TYPE } : { present: false },
          soil: r[2] || null,
        };
      }).catch(function () { return null; });
    return _envCache[key];
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
    // environmental: WIRE THIS when wetlands/flood/soil become a county PostGIS overlay and
    // per-feature acreage/zone is clipped into the cohort features (then the core's
    // 'environmental' aggregator renders area-wide % automatically — see envCardDeterministic):
    //   environmental: { floodZone: 'flood_zone', floodFlag: 'in_sfha',
    //                    wetlandAcres: 'wetland_acres', soilClass: 'soil_class' }
  };
  // 'environmental' is requested but gates itself off until PROFILE_FIELDS.environmental exists
  // (supported() returns it only when env fields are configured) — so it's a no-op today.
  var AGGS = ['composition', 'value-stats', 'value-change', 'ownership', 'area-distribution', 'environmental'];

  var _ctx = { parcelId: null, mode: 'buffer', distanceFt: DEFAULT_FT, geoName: null, geoId: null, drawnGeometry: null };

  // Build the /cohort selector for the current area mode. Buffer needs a parcel; a named
  // geography needs a chosen name/id; a drawn area needs a sketched polygon. Returns null
  // when the mode isn't satisfiable yet.
  function buildSelector() {
    if (_ctx.mode === 'buffer') {
      if (_ctx.parcelId == null) return null;
      return { type: 'buffer', parcel_id: _ctx.parcelId, distance_ft: _ctx.distanceFt };
    }
    if (_ctx.mode === 'drawn') {
      if (!_ctx.drawnGeometry) return null;
      return { type: 'drawn-polygon', geometry: _ctx.drawnGeometry };
    }
    if (_ctx.geoName == null && _ctx.geoId == null) return null;
    var sel = { type: 'named-geography', geography: _ctx.mode };
    if (_ctx.geoId != null) sel.id = _ctx.geoId; else sel.name = _ctx.geoName;
    return sel;
  }

  function open(opts) {
    if (!enabled()) return;
    opts = opts || {};
    // Any open that isn't the draw-completion itself means a pending draw-watch is stale.
    if (!opts.drawnGeometry) stopDrawWatch();
    if (opts.mode) _ctx.mode = opts.mode;
    if (opts.geoName !== undefined) _ctx.geoName = opts.geoName;
    if (opts.geoId !== undefined) _ctx.geoId = opts.geoId;
    if (opts.drawnGeometry !== undefined) _ctx.drawnGeometry = opts.drawnGeometry;
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
    if (!selector) {
      var msg = _ctx.mode === 'drawn'
        ? 'Click “Draw an area” above, then sketch a neighborhood on the map.'
        : 'Pick a ' + modeLabel(_ctx.mode).toLowerCase() + ' above to profile it.';
      renderBody('<p class="pv-prof-empty">' + esc(msg) + '</p>'); return;
    }
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
        maybeEnvironmental(result.facts, data.selector);   // area-wide clip if available, else center read
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

  // ── Environmental card ──────────────────────────────────────────────────────
  // Two paths (DIC-588): if the cohort core produced a deterministic `environmental`
  // aggregate (per-feature clip fields exist → the future county-wetland path), render that
  // area-wide. Otherwise sample the area's CENTER for a coarse, clearly-labeled read.
  function maybeEnvironmental(facts, selector) {
    var body = el('pv-profile-body'); if (!body) return;
    if (facts.environmental && hasEnv(facts.environmental)) {
      insertEnvCard(body, envCardDeterministic(facts.environmental));
      return;
    }
    var center = selector && selector.center;
    if (!center) return;                                   // nothing to sample → no card
    var token = [_ctx.mode, _ctx.parcelId, _ctx.distanceFt, _ctx.geoId, _ctx.geoName].join(':');
    _ctx.envToken = token;
    insertEnvCard(body, envLoadingHtml());
    envAtPoint(center).then(function (e) {
      if (_ctx.envToken !== token) return;
      var slot = el('pv-prof-env'); if (!slot) return;
      if (e) slot.outerHTML = envCardCenter(e);
      else if (slot.parentNode) slot.parentNode.removeChild(slot);
    });
  }
  function hasEnv(e) { return !!(e && (e.flood || e.wetland || e.soil)); }
  function insertEnvCard(body, html) {
    var note = body.querySelector('.pv-prof-note');
    if (note) note.insertAdjacentHTML('beforebegin', html); else body.insertAdjacentHTML('beforeend', html);
  }
  function envLoadingHtml() {
    return '<section id="pv-prof-env" class="pv-prof-card pv-prof-env">' +
      '<h3 class="pv-prof-card-t">Environmental</h3>' +
      '<p class="pv-prof-empty">Checking flood, wetlands &amp; soil…</p></section>';
  }
  function floodText(fl) {
    if (!fl) return '—';
    if (fl.sfha === 'T' || fl.sfha === true) return 'Zone ' + esc(fl.zone || 'A') + ' — in the 1% (100-yr) floodplain';
    return 'Zone ' + esc(fl.zone || 'X') + ' — no special flood hazard';
  }
  function envCardCenter(e) {
    var rows =
      '<li><span class="pv-prof-env-k">Flood</span><span>' + floodText(e.flood) + '</span></li>' +
      '<li><span class="pv-prof-env-k">Wetlands</span><span>' +
        (e.wetlands && e.wetlands.present ? (esc(e.wetlands.type || 'mapped wetland') + ' at center') : 'none mapped at center') + '</span></li>' +
      '<li><span class="pv-prof-env-k">Soil</span><span>' + (e.soil ? esc(e.soil) : '—') + '</span></li>';
    return '<section id="pv-prof-env" class="pv-prof-card pv-prof-env">' +
      '<h3 class="pv-prof-card-t">Environmental <span class="pv-prof-env-tag">sampled at area center</span></h3>' +
      '<ul class="pv-prof-env-list">' + rows + '</ul>' +
      '<p class="pv-prof-subnote">Sampled at the area’s center — not a full clip. Area-wide wetland/flood coverage arrives with the county wetland layer; for one parcel use the Environmental tool.</p>' +
      '</section>';
  }
  // Deterministic area-wide env (future, once per-feature clip fields exist).
  function envCardDeterministic(en) {
    var parts = [];
    if (en.flood) {
      var mix = en.flood.zoneMix || [];
      var sfha = en.flood.inSfhaShare != null ? Math.round(en.flood.inSfhaShare * 100) + '% in a special flood hazard area' : '';
      parts.push('<div class="pv-prof-env-grp"><span class="pv-prof-env-k">Flood</span> ' +
        esc(mix.map(function (z) { return (z.label || z.key) + ' ' + Math.round((z.share || 0) * 100) + '%'; }).slice(0, 3).join(' · ')) +
        (sfha ? ' <span class="pv-prof-env-flag">' + sfha + '</span>' : '') + '</div>');
    }
    if (en.wetland) {
      var w = en.wetland;
      parts.push('<div class="pv-prof-env-grp"><span class="pv-prof-env-k">Wetlands</span> ' +
        (w.wetlandAcreShare != null ? Math.round(w.wetlandAcreShare * 100) + '% of acreage' : '') +
        (w.withWetlandShare != null ? ' · ' + Math.round(w.withWetlandShare * 100) + '% of parcels touch wetland' : '') + '</div>');
    }
    if (en.soil) {
      var s = (en.soil.soilMix || []).slice(0, 3);
      parts.push('<div class="pv-prof-env-grp"><span class="pv-prof-env-k">Soil</span> ' +
        esc(s.map(function (m) { return (m.label || m.key) + ' ' + Math.round((m.share || 0) * 100) + '%'; }).join(' · ')) + '</div>');
    }
    return '<section id="pv-prof-env" class="pv-prof-card pv-prof-env">' +
      '<h3 class="pv-prof-card-t">Environmental</h3>' + parts.join('') +
      '<p class="pv-prof-subnote">Area-wide coverage from the county environmental layers.</p></section>';
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
    if (_ctx.mode === 'drawn') {
      return '<button type="button" id="pv-prof-draw" class="pv-prof-drawbtn">✏️ ' +
        (_ctx.drawnGeometry ? 'Redraw area' : 'Draw an area') + '</button>';
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
    var drawBtn = overlay.querySelector('#pv-prof-draw');
    if (drawBtn) drawBtn.addEventListener('click', startDrawArea);
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

  // ── Draw-an-area flow (drawn-polygon selector) ──────────────────────────────
  // Hands the user the polygon draw tool, hides the modal so they can sketch on the map,
  // and reopens the Profile on the finished shape. Uses the contract drawing globals
  // (PS_DRAWING_TOOLS / PS_ANNOTATION_STORE) read-only — never mutates them.
  function annIds(store) {
    var ids = {}, st = store.getState ? store.getState() : null;
    var feats = (st && st.annotations && st.annotations.features) || [];
    feats.forEach(function (f) { if (f && f.id != null) ids[f.id] = 1; });
    return ids;
  }
  function newPolygon(store, beforeIds) {
    var st = store.getState ? store.getState() : null;
    var feats = (st && st.annotations && st.annotations.features) || [];
    for (var i = 0; i < feats.length; i++) {
      var f = feats[i];
      if (f && !beforeIds[f.id] && f.geometry && f.geometry.type === 'Polygon' &&
          f.geometry.coordinates && f.geometry.coordinates.length) return f.geometry;
    }
    return null;
  }
  function stopDrawWatch() { if (_ctx.drawUnsub) { _ctx.drawUnsub(); _ctx.drawUnsub = null; } }
  function startDrawArea() {
    var D = root.PS_DRAWING_TOOLS, store = root.PS_ANNOTATION_STORE;
    if (!D || !D.setActiveDrawTool || !store || !store.subscribe || !store.getState) {
      return hint('Drawing isn’t available right now.');
    }
    stopDrawWatch();   // clear any prior watch (e.g. a cancelled draw)
    close();           // hide the modal so the map is reachable
    hint('Draw an area: click to add points, double-click to finish.');
    var before = annIds(store);
    _ctx.drawUnsub = store.subscribe(function () {
      var poly = newPolygon(store, before);
      if (!poly) return;                      // some other store change — keep waiting
      stopDrawWatch();
      D.setActiveDrawTool(null);              // put the tool away
      open({ mode: 'drawn', drawnGeometry: poly });
    });
    D.setActiveDrawTool('polygon');
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
