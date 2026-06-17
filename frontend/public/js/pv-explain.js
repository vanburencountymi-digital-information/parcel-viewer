/**
 * pv-explain.js — AI-driven per-parcel explainers (DIC-370 Assessment Explainer).
 *
 * Two-engine discipline (verify-don't-trust):
 *   1. Deterministic "truth" — assembleAssessmentFacts() pulls this parcel's
 *      verified figures straight from the API (/parcel/{id}). These numbers are
 *      rendered by US and are never originated by the model.
 *   2. AI "teacher" — the Map Buddy /explain service narrates ONLY those figures
 *      and cites Michigan law from a vetted list (see map-buddy/backend/agent.py).
 *
 * The window is built from a base template via PV_TEMPLATE; print/export reuse
 * PV_DOC. Persistence + stable custom URLs are deferred (DIC-400/372 Phase 4).
 *
 * Exposes: window.PV_EXPLAIN { openAssessment }
 */
(function (root) {
  'use strict';

  var T = root.PV_TEMPLATE;
  function esc(s) { return T ? T.escape(s) : String(s == null ? '' : s); }

  // ── Service endpoints ──────────────────────────────────────────────────────
  function apiBase() { return root.API_BASE || (root.PS_CONFIG && root.PS_CONFIG.API_BASE) || '/api'; }

  // Resolve the Map Buddy service base the same way demo/index.html mounts it, so
  // the explainer talks to the same Cloud Run service (one key, one rate-limiter).
  function explainBase() {
    var isLocal = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
    return (root.COUNTY && root.COUNTY.endpoints && root.COUNTY.endpoints.mapBuddy) ||
      root.MAP_BUDDY_API ||
      (isLocal && '/map-buddy-api') ||
      'https://map-buddy-toaozre74a-uc.a.run.app';
  }

  // ── Formatting helpers ─────────────────────────────────────────────────────
  function num(v) { if (v == null || v === '') return null; var n = Number(v); return isNaN(n) ? null : n; }
  function money(v) {
    var n = num(v);
    if (n == null) return null;
    return '$' + Math.round(n).toLocaleString('en-US');
  }
  function dash(v) { return (v == null || v === '') ? '—' : v; }

  // Resolve a county code → label using the same maps the popup uses
  // (window.COUNTY.labels, from county-config.js). `style:"code-name"` renders
  // "401 – Residential"; "name" prefers the name and falls back to the code.
  function resolveLabel(mapKey, code, style) {
    code = code != null ? String(code).trim() : null;
    if (!code) return null;
    var name = (root.COUNTY && root.COUNTY.labels && root.COUNTY.labels[mapKey] && root.COUNTY.labels[mapKey][code]) || null;
    if (!name) return code;
    return style === 'code-name' ? (code + ' – ' + name) : name;
  }

  // Split AI prose (blank-line-separated paragraphs) into escaped <p> blocks.
  function paras(text) {
    if (!text) return '';
    return String(text).split(/\n\s*\n/).map(function (p) {
      return '<p>' + esc(p.trim()).replace(/\n/g, '<br>') + '</p>';
    }).join('');
  }

  // ── 1. Deterministic truth layer ───────────────────────────────────────────
  // Pull the authoritative record and assemble the verified figures. Anything we
  // can't get from the DB is simply omitted — never guessed.
  function assembleAssessmentFacts(parcel) {
    var id = parcel && parcel.id;
    if (id == null) return Promise.reject(new Error('no parcel id'));
    return fetch(apiBase() + '/parcel/' + encodeURIComponent(id), { cache: 'no-cache' })
      .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)); })
      .then(function (feat) {
        var p = (feat && feat.properties) || {};
        var av = num(p.assessed_value);
        // DB stores assessed_value_yr0..yr4 newest-first (see map.js showParcelInfo).
        var histNewestFirst = [p.assessed_value_yr0, p.assessed_value_yr1, p.assessed_value_yr2,
                               p.assessed_value_yr3, p.assessed_value_yr4].map(num);
        // Year-labeled, oldest→newest — clearer for the model and the chart.
        var oldestFirst = histNewestFirst.slice().reverse();
        var curYear = new Date().getFullYear();
        var n = oldestFirst.length;
        var byYear = oldestFirst.map(function (v, i) {
          return { year: curYear - (n - 1 - i), assessed_value: v };
        }).filter(function (e) { return e.assessed_value != null; });
        return {
          pin: p.pin || p.parcel_no || (parcel && parcel.pin) || '',
          owner_name: p.owner_name || null,
          municipality: p.municipality || null,
          school_district: resolveLabel('schoolDist', p.school_dist, 'name'),
          classification: resolveLabel('propClass', p.prop_class, 'code-name'),
          pre_percent: num(p.homestead),
          assessed_value: av,
          prev_assessed_value: num(p.prev_assessed_value),
          taxable_value: num(p.taxable_value),
          prev_taxable_value: num(p.prev_taxable_value),
          // Deterministic, clearly-labeled derivation (same as the popup's TMV):
          true_cash_value_estimate: av != null ? av * 2 : null,
          // Newest-first for the chart (it reverses); year-labeled for the model.
          assessed_value_history: histNewestFirst,
          assessed_value_by_year: byYear,
        };
      });
  }

  // Deterministic classifier (NO AI): which kind of description is this? Used to
  // pick a render hint and to frame the AI explanation. It never parses geometry.
  function classifyDescription(text) {
    var t = (text || '').toUpperCase();
    if (!t.trim()) return { type: 'unknown', label: null, note: '' };
    var hasMB = /\b(COM|COMM|BEG|POB|TH|THENCE)\b/.test(t) ||
      /\d\s*(FT|CHS?|RDS?|LKS?)\b/.test(t) || /\d\s*°/.test(t) ||
      /[NS]\s*\d+[°\s].*\b[EW]\b/.test(t);
    var hasPlat = /\b(LOT|BLK|BLOCK|PLAT)\b/.test(t) || /\b(ADD|SUB|ASSESSOR'?S PLAT)\b/.test(t);
    var hasPLSS = /\bSEC\b/.test(t) || /\bT\d+[NS]\b/.test(t) || /\bR\d+[EW]\b/.test(t) || /1\/4|1\/2/.test(t);
    // Metes-and-bounds wins even when anchored in a PLSS/section reference.
    if (hasMB) return { type: 'metes_bounds', label: 'Metes & bounds', note: 'a traverse of bearings and distances' };
    if (hasPlat) return { type: 'platted_lot', label: 'Platted lot', note: 'a lot within a recorded subdivision' };
    if (hasPLSS) return { type: 'aliquot_plss', label: 'Aliquot / PLSS', note: 'section and quarter divisions' };
    return { type: 'unknown', label: null, note: '' };
  }

  // ── Deterministic per-call parser (DIC-369 Phase 2; NO AI) ──────────────────
  // Extracts structured calls from the verbatim text. Geometry is NOT computed
  // (the traverse is never walked/closed — that's Phase 3). This is the verified
  // "truth" the AI narrates; the model must not recompute or alter these numbers.
  function _normDesc(t) {
    return String(t || '').toUpperCase()
      .replace(/[°º]/g, ' DEG ')
      .replace(/[‘’`]/g, "'").replace(/[“”]/g, '"')
      .replace(/\s+/g, ' ').trim();
  }

  // Quadrant bearing → azimuth (deg clockwise from north) + 16-point compass.
  var _COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  function _azimuth(ns, deg, min, sec, ew) {
    var a = deg + (min || 0) / 60 + (sec || 0) / 3600;
    if (ns === 'N' && ew === 'E') return a;
    if (ns === 'S' && ew === 'E') return 180 - a;
    if (ns === 'S' && ew === 'W') return 180 + a;
    if (ns === 'N' && ew === 'W') return 360 - a;
    return null;
  }
  function _compass(az) { return az == null ? null : _COMPASS[Math.round(az / 22.5) % 16]; }

  var _UNIT_FT = { FT: 1, "'": 1, CH: 66, CHS: 66, RD: 16.5, RDS: 16.5, LK: 0.66, LKS: 0.66 };
  var _UNIT_NAME = { FT: 'feet', "'": 'feet', CH: 'chains', CHS: 'chains', RD: 'rods', RDS: 'rods', LK: 'links', LKS: 'links' };

  function _parseBearing(s) {
    var m = s.match(/\b([NS])\s*(\d+(?:\.\d+)?)\s*(?:DEG)?\s*(?:(\d+)\s*')?\s*(?:(\d+)\s*")?\s*([EW])\b/);
    if (!m) return null;
    var ns = m[1], deg = parseFloat(m[2]), min = m[3] ? parseInt(m[3], 10) : 0, sec = m[4] ? parseInt(m[4], 10) : 0, ew = m[5];
    var az = _azimuth(ns, deg, min, sec, ew);
    var text = ns + ' ' + deg + '°' + (min ? (' ' + min + "'") : '') + (sec ? (' ' + sec + '"') : '') + ' ' + ew;
    return { ns: ns, deg: deg, min: min, sec: sec, ew: ew, azimuth: az == null ? null : Math.round(az * 100) / 100, compass: _compass(az), text: text, raw: m[0] };
  }
  function _parseDistance(s) {
    var m = s.match(/(\d+(?:\.\d+)?)\s*(FT|CHS?|RDS?|LKS?|')\b/);
    if (!m) return null;
    var v = parseFloat(m[1]), u = m[2];
    return { value: v, unit: u, unit_name: _UNIT_NAME[u] || u, feet: Math.round(v * (_UNIT_FT[u] || 1) * 100) / 100, raw: m[0] };
  }

  // Plain-language gloss for one course (deterministic; the AI can enrich further).
  var _COMPASS_WORDS = {
    N: 'north', NNE: 'north-northeast', NE: 'northeast', ENE: 'east-northeast',
    E: 'east', ESE: 'east-southeast', SE: 'southeast', SSE: 'south-southeast',
    S: 'south', SSW: 'south-southwest', SW: 'southwest', WSW: 'west-southwest',
    W: 'west', WNW: 'west-northwest', NW: 'northwest', NNW: 'north-northwest',
  };
  var _NOTE_EXPAND = [
    [/\bALG\b/g, 'along the'], [/\bSEC\b/g, 'section'], [/\bLN\b/g, 'line'], [/\bCOR\b/g, 'corner'],
    [/\bR\/W\b/g, 'right-of-way'], [/\bC\/?L\b/g, 'centerline'],
    [/\bNLY\b/g, 'northerly'], [/\bSLY\b/g, 'southerly'], [/\bELY\b/g, 'easterly'], [/\bWLY\b/g, 'westerly'],
    [/\bN\b/g, 'north'], [/\bS\b/g, 'south'], [/\bE\b/g, 'east'], [/\bW\b/g, 'west'],
  ];
  function _expandNote(s) {
    var out = ' ' + s + ' ';
    _NOTE_EXPAND.forEach(function (p) { out = out.replace(p[0], p[1]); });
    return out.replace(/\s+/g, ' ').trim();
  }
  function _coursePlain(c) {
    var dir = c.bearing && c.bearing.compass ? _COMPASS_WORDS[c.bearing.compass] : null;
    var s = dir ? ('Runs ' + dir) : 'Runs';
    if (c.distance) {
      s += ' about ' + ((c.distance.unit === 'FT' || c.distance.unit === "'")
        ? (c.distance.value + ' feet')
        : (c.distance.value + ' ' + c.distance.unit_name + ' (' + c.distance.feet + ' ft)'));
    }
    if (c.note) s += ', ' + _expandNote(c.note).toLowerCase();
    return s;
  }

  // VBC-specific: descriptions usually LEAD with recorded-deed Liber/Page refs and
  // may carry administrative *** annotations *** (combinations/splits). Pull both
  // out so they're explained separately and don't pollute the geometry parse.
  // TODO: move these conventions into per-county config (DIC-458) as counties are added.
  function _extractReferences(text) {
    var refs = [], re = /\bL(?:IBER|IB)?\.?\s*(\d+)\s*[,\/\- ]?\s*P(?:AGE|G)?\.?\s*(\d+)/gi, m;
    while ((m = re.exec(text))) refs.push({ liber: m[1], page: m[2], raw: m[0].replace(/\s+/g, ' ').trim() });
    return { references: refs, text: refs.length ? text.replace(re, ' ') : text };
  }
  function _titleCase(d) { return d.toLowerCase().replace(/\b\w/g, function (ch) { return ch.toUpperCase(); }); }
  function _parseAnnotation(raw) {
    raw = raw.replace(/\s+/g, ' ').trim().replace(/\.$/, '');
    var pins = raw.match(/\b\d{2}-\d{2}-\d{3}-\d{3}-\d{2}\b/g) || [];
    var date = (raw.match(/\b\d{1,2}\s+[A-Z]+\s+\d{4}\b/) || [])[0] || null;
    var year = (raw.match(/\bFOR\s+(\d{4})\b/i) || [])[1] || null;
    var action = /COMBINAT|COMBINED/i.test(raw) ? 'combination' : (/SPLIT/i.test(raw) ? 'split' : null);
    return { raw: raw, action: action, pins: pins, date: date ? _titleCase(date) : null, tax_year: year };
  }
  function _extractAnnotations(text) {
    var anns = [], t = text, re = /\*{2,}\s*([^*]+?)\s*\*{2,}/g, m;
    while ((m = re.exec(text))) anns.push(_parseAnnotation(m[1]));
    t = t.replace(re, ' ');
    var re2 = /\b(?:COMBINATION OF|COMBINED WITH|SPLIT (?:FROM|FOR)|FORMERLY)\b[^.]*\.?/gi;
    while ((m = re2.exec(t))) anns.push(_parseAnnotation(m[0]));
    return { annotations: anns, text: t.replace(re2, ' ') };
  }
  function annotationPlain(a) {
    if (a.action === 'combination' && a.pins.length) {
      return 'Created by combining parcel' + (a.pins.length > 1 ? 's ' : ' ') + a.pins.join(' and ') +
        (a.date ? (' on ' + a.date) : '') + (a.tax_year ? (', effective for the ' + a.tax_year + ' tax year') : '') + '.';
    }
    if (a.action === 'split' && a.pins.length) {
      return 'Split from parcel' + (a.pins.length > 1 ? 's ' : ' ') + a.pins.join(', ') +
        (a.date ? (' on ' + a.date) : '') + (a.tax_year ? (', effective for the ' + a.tax_year + ' tax year') : '') + '.';
    }
    return a.raw;
  }

  function parseMetesAndBounds(text) {
    var t = _normDesc(text);
    var parts = t.split(/\bTH(?:ENCE)?\b/);
    var commencement = parts.shift().trim();
    var courses = parts.map(function (seg, i) {
      seg = seg.trim();
      var bearing = _parseBearing(seg), dist = _parseDistance(seg);
      var note = seg;
      if (bearing) note = note.replace(bearing.raw, ' ');
      if (dist) note = note.replace(dist.raw, ' ');
      note = note
        .replace(/\bTO\s+P\.?\s?O\.?\s?B\b.*$/, '')   // closings shown separately
        .replace(/\bTO\s+BEG\b.*$/, '')
        .replace(/\bEXC(?:EPT)?\b.*$/, '')
        .replace(/\bDEG\b/g, '').replace(/[.,]/g, ' ').replace(/\s+/g, ' ').trim();
      var c = { index: i + 1, bearing: bearing, distance: dist, note: note };
      c.plain = _coursePlain(c);
      return c;
    }).filter(function (c) { return c.bearing || c.distance; });
    var closings = [];
    if (/TO\s+P\.?\s?O\.?\s?B|TO\s+BEG|POINT\s+OF\s+BEG/.test(t)) closings.push('Returns to the Point of Beginning');
    var exc = t.match(/\bEXC(?:EPT)?\b([^.]*)/);
    if (exc && exc[1].trim()) closings.push('Except: ' + exc[1].trim());
    return { kind: 'metes_bounds', commencement: commencement, courses: courses, closings: closings };
  }
  function parseAliquot(text) {
    var t = _normDesc(text);
    var sec = (t.match(/\bSEC\s*(\d+)/) || [])[1];
    var tw = t.match(/\bT\s*(\d+)\s*([NS])\b/), rg = t.match(/\bR\s*(\d+)\s*([EW])\b/);
    var quarters = (t.match(/\b(NW|NE|SW|SE|N|S|E|W)\s*1\/[24]/g) || []).map(function (q) { return q.replace(/\s+/g, ' '); });
    return {
      kind: 'aliquot_plss', section: sec || null,
      town: tw ? (tw[1] + ' ' + (tw[2] === 'N' ? 'North' : 'South')) : null,
      range: rg ? (rg[1] + ' ' + (rg[2] === 'E' ? 'East' : 'West')) : null,
      quarters: quarters,
    };
  }
  function parsePlatted(text) {
    var t = _normDesc(text);
    return {
      kind: 'platted_lot',
      lot: (t.match(/\bLOT\s*(\d+)/) || [])[1] || null,
      block: (t.match(/\bBL(?:OC)?K\s*(\d+)/) || [])[1] || null,
    };
  }
  function parseDescription(text, type) {
    if (!text) return null;
    // Pull VBC-specific deed refs + admin annotations before the geometry parse.
    var r = _extractReferences(text);
    var a = _extractAnnotations(r.text);
    var geom = a.text;
    var base;
    if (type === 'metes_bounds') base = parseMetesAndBounds(geom);
    else if (type === 'aliquot_plss') base = parseAliquot(geom);
    else if (type === 'platted_lot') base = parsePlatted(geom);
    else base = { kind: type || 'unknown' };
    base.references = r.references;
    base.annotations = a.annotations.map(function (an) { return { raw: an.raw, action: an.action, pins: an.pins, date: an.date, tax_year: an.tax_year, plain: annotationPlain(an) }; });
    return base;
  }

  // Truth layer for the tax description (DIC-369). The verbatim text + detected
  // type ARE the verified input; the model explains only this, never geometry.
  function assembleTaxDescriptionFacts(parcel) {
    var id = parcel && parcel.id;
    if (id == null) return Promise.reject(new Error('no parcel id'));
    return fetch(apiBase() + '/parcel/' + encodeURIComponent(id), { cache: 'no-cache' })
      .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)); })
      .then(function (feat) {
        var p = (feat && feat.properties) || {};
        var text = p.ps_legal_description || p.legal_description || '';
        var cls = classifyDescription(text);
        return {
          pin: p.pin || p.parcel_no || (parcel && parcel.pin) || '',
          tax_id: p.pin || p.parcel_no || '',
          description_text: text,
          description_type: cls.type,
          type_label: cls.label,
          type_note: cls.note,
          parsed: parseDescription(text, cls.type),   // structured calls (Phase 2)
        };
      });
  }

  // ── 2. AI teacher ──────────────────────────────────────────────────────────
  // Returns the structured explanation, or null on any failure (so the caller
  // degrades to the deterministic figures + static educational fallback).
  function fetchExplanation(facts, topic) {
    return fetch(explainBase() + '/explain', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: topic || 'assessment', facts: facts }),
    })
      .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)); })
      .then(function (res) { return (res && res.ok && res.explanation) ? res.explanation : null; })
      .catch(function () { return null; });
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  function figureRows(f) {
    var rows = [];
    function add(label, value, note) { if (value != null && value !== '') rows.push({ label: label, value: value, note: note || '' }); }
    add('Assessed Value (AV)', money(f.assessed_value), 'assessor’s estimate of 50% of market value');
    add('Taxable Value (TV)', money(f.taxable_value), 'the value your millage is applied to (capped by Proposal A)');
    add('True Cash Value', money(f.true_cash_value_estimate), 'estimated full market value (about 2× AV)');
    if (f.pre_percent != null) add('Principal Residence Exemption', f.pre_percent + '%', 'share exempt from local school operating tax');
    add('Classification', f.classification, 'Michigan STC property class');
    add('School District', f.school_district, '');
    return rows;
  }

  // 5-year AV trend as a labeled SVG chart (mirrors the popup's chart so the look
  // is consistent). assessed_value_history is newest-first → reverse for
  // oldest→newest, label each bar with its year and value. Bars use a min→max
  // scale (not from zero) so year-over-year changes in a narrow range stay
  // visible; exact dollar values sit above each bar, so nothing is misread.
  function historyChartSvg(f, opts) {
    opts = opts || {};
    var vals = (f.assessed_value_history || []).slice().reverse();
    var valid = vals.filter(function (v) { return v != null; });
    if (valid.length < 2) return '';
    var curYear = new Date().getFullYear();
    var maxV = Math.max.apply(null, valid), minV = Math.min.apply(null, valid);
    var W = 320, H = 96, labelH = 15, valueH = 13, areaH = H - labelH - valueH;
    var n = vals.length, colW = W / n, barW = colW * 0.5;
    var dark = !opts.doc && document.documentElement.getAttribute('data-theme') === 'dark';
    var valClr = dark ? '#b09a7a' : '#6D5C52';
    var yrClr = dark ? '#b9bdc4' : '#4b5563';
    var gTop = dark ? '#6b5a38' : '#CBAB7A', gBot = dark ? '#4a3e26' : '#B58D4A';
    var curFill = dark ? '#d4a862' : '#8B6535';   // current year stands out
    var bars = vals.map(function (v, i) {
      var cx = colW * i + colW / 2, yr = curYear - (n - 1 - i);
      if (v == null) return '<text x="' + cx + '" y="' + (H - 3) + '" text-anchor="middle" font-size="10" fill="' + yrClr + '">' + yr + '</text>';
      var frac = maxV === minV ? 1 : (0.22 + 0.78 * (v - minV) / (maxV - minV));
      var bh = Math.max(3, Math.round(frac * areaH));
      var bx = cx - barW / 2, by = valueH + areaH - bh;
      var lbl = '$' + Math.round(v / 1000) + 'k';
      var fill = i === n - 1 ? curFill : 'url(#xp-av-grad)';
      return '<rect x="' + bx.toFixed(1) + '" y="' + by.toFixed(1) + '" width="' + barW.toFixed(1) + '" height="' + bh.toFixed(1) + '" rx="2" fill="' + fill + '"/>' +
        '<text x="' + cx + '" y="' + (by - 3).toFixed(1) + '" text-anchor="middle" font-size="10" font-weight="600" fill="' + valClr + '">' + lbl + '</text>' +
        '<text x="' + cx + '" y="' + (H - 3) + '" text-anchor="middle" font-size="10" fill="' + yrClr + '">' + yr + '</text>';
    }).join('');
    var defs = '<defs><linearGradient id="xp-av-grad" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0%" stop-color="' + gTop + '"/><stop offset="100%" stop-color="' + gBot + '"/></linearGradient></defs>';
    return '<svg viewBox="0 0 ' + W + ' ' + H + '" style="width:100%;height:auto;display:block" role="img" aria-label="Five-year assessed value history, oldest to newest">' + defs + bars + '</svg>';
  }

  var TPL =
    '<div class="pv-xp">' +
      '{{#lead}}<p class="pv-modal-lead">{{lead}}</p>{{/lead}}' +

      '{{#is_assessment}}<div class="pv-xp-figs" role="group" aria-label="Recorded figures">' +
        '<div class="pv-xp-figs-title">By the numbers' +
          '{{#pin}}<span class="pv-xp-pin">{{pin}}</span>{{/pin}}</div>' +
        '<table class="pv-xp-table">{{#figures}}' +
          '<tr><th>{{label}}{{#note}}<span class="pv-xp-note"> · {{note}}</span>{{/note}}</th><td>{{value}}</td></tr>' +
        '{{/figures}}</table>' +
        '{{#history_svg}}<div class="pv-xp-hist"><div class="pv-xp-hist-cap">Assessed value — last {{history_years}} years (current year highlighted)</div>{{{history_svg}}}</div>{{/history_svg}}' +
      '</div>{{/is_assessment}}' +

      '{{#is_taxdesc}}<div class="pv-xp-figs" role="group" aria-label="Recorded tax description">' +
        '<div class="pv-xp-figs-title">Tax description{{#pin}}<span class="pv-xp-pin">{{pin}}</span>{{/pin}}</div>' +
        '{{#description_text}}<div class="pv-xp-desc">{{description_text}}</div>{{/description_text}}' +
        '{{^description_text}}<div class="pv-xp-desc pv-xp-desc-empty">No tax description is on record for this parcel.</div>{{/description_text}}' +
        '{{#type_label}}<div class="pv-xp-desc-type"><span class="pv-badge">{{type_label}}</span>{{#type_note}} {{type_note}}{{/type_note}}</div>{{/type_label}}' +
        '{{{breakdown_html}}}' +
      '</div>{{/is_taxdesc}}' +

      '{{#has_ai}}' +
        '{{#summary_html}}<div class="pv-xp-summary">{{{summary_html}}}</div>{{/summary_html}}' +
        '{{#sections}}<section class="pv-xp-section"><h3 class="pv-xp-h">{{heading}}</h3><div class="pv-xp-body">{{{body_html}}}</div></section>{{/sections}}' +
        '{{#has_glossary}}<section class="pv-xp-section"><h3 class="pv-xp-h">Key terms</h3><dl class="pv-xp-gloss">{{#glossary}}<dt>{{term}}</dt><dd>{{definition}}</dd>{{/glossary}}</dl></section>{{/has_glossary}}' +
        '{{#has_statutes}}<section class="pv-xp-section"><h3 class="pv-xp-h">Michigan law</h3><ul class="pv-xp-statutes">{{#statutes}}<li><span class="pv-xp-stat-name">{{name}}</span> <span class="pv-xp-stat-cite">{{citation}}</span><span class="pv-xp-stat-plain">{{plain}}</span></li>{{/statutes}}</ul></section>{{/has_statutes}}' +
        '{{#disclaimer}}<p class="pv-modal-note">{{disclaimer}}</p>{{/disclaimer}}' +
      '{{/has_ai}}' +

      '{{^has_ai}}' +
        '{{#fallback_items}}<div class="pv-help-item"><div class="pv-help-h">{{term}}</div><div class="pv-help-p">{{definition}}</div></div>{{/fallback_items}}' +
        '{{#fallback_teaser}}<div class="pv-teaser"><div class="pv-teaser-title"><span class="pv-badge">Offline</span> Live explainer unavailable</div>' +
          '<p class="pv-teaser-body">{{fallback_teaser}}</p></div>{{/fallback_teaser}}' +
      '{{/has_ai}}' +

      '<div class="pv-xp-actions">' +
        '<button type="button" class="pv-btn-ghost" data-xp="print">Print</button>' +
        '<button type="button" class="pv-btn-ghost" data-xp="download">Download HTML</button>' +
      '</div>' +
    '</div>';

  // Concise educational fallback per topic (used only when the AI is unreachable).
  var FALLBACK_ITEMS = {
    assessment: [
      { term: 'Assessed Value (AV) & SEV', definition: 'AV is set by the assessor at 50% of True Cash (market) Value. After county/state equalization confirms that 50% level, AV becomes the State Equalized Value (SEV).' },
      { term: 'Taxable Value (TV) & Proposal A', definition: 'TV is the value you’re actually taxed on. Under Proposal A it rises each year by the lesser of 5% or inflation—so it often sits below AV—until the property sells, when it “uncaps” to the SEV.' },
      { term: 'Assessing vs. equalization vs. appraisal', definition: 'Assessing values every parcel for taxation; equalization checks those values are uniform across units; an appraisal is an independent market-value opinion for a specific purpose.' },
      { term: 'Appeals', definition: 'Disagree with your assessment? Appeal first to the March Board of Review, then the Michigan Tax Tribunal.' },
    ],
    tax_description: [
      { term: 'A tax description is not a legal description', definition: 'It’s an abbreviated shorthand kept on the assessment roll to identify the parcel for taxation. The recorded deed — not this text — is the controlling legal document; never use a tax description on deeds, titles, or to settle a boundary.' },
      { term: 'Common abbreviations', definition: 'COM/BEG = commencing/beginning point · TH = thence (the next course) · FT/CH/RD = feet/chains/rods · SEC, T, R = section, town, range · “NW 1/4 of SE 1/4” = nested quarter divisions · LOT/BLK = a lot and block in a recorded plat.' },
      { term: 'Mapping the boundary', definition: 'Tracing each call on the map is a planned future feature; for now this window explains the terminology, not the geometry.' },
    ],
  };

  // Per-topic config: how to assemble facts, what to call it, the header block,
  // and the offline fallback. New explainers register here (mirrors the backend
  // EXPLAINER_PROFILES seam).
  function assessmentHeader(facts) {
    return {
      is_assessment: true,
      figures: figureRows(facts),
      history_svg: historyChartSvg(facts),
      history_years: (facts.assessed_value_by_year || []).length,
    };
  }
  // Walk the courses into a LOCAL traced outline (relative feet, not georeferenced
  // and not rotated to the real parcel — that's Phase 3). Closure gap is a useful
  // deterministic signal we surface honestly.
  function _walkTraverse(courses) {
    var usable = (courses || []).filter(function (c) { return c.bearing && c.bearing.azimuth != null && c.distance; });
    if (usable.length < 2) return null;
    var pts = [{ x: 0, y: 0 }], x = 0, y = 0, legs = [];
    usable.forEach(function (c) {
      var az = c.bearing.azimuth * Math.PI / 180, d = c.distance.feet;
      var nx = x + Math.sin(az) * d, ny = y + Math.cos(az) * d;
      legs.push({ from: { x: x, y: y }, to: { x: nx, y: ny }, index: c.index });
      pts.push({ x: nx, y: ny }); x = nx; y = ny;
    });
    return { pts: pts, legs: legs, closureFt: Math.round(Math.sqrt(x * x + y * y) * 10) / 10 };
  }
  function _traverseDiagram(p) {
    var w = _walkTraverse(p.courses);
    if (!w) return '';
    var xs = w.pts.map(function (q) { return q.x; }), ys = w.pts.map(function (q) { return q.y; });
    var minx = Math.min.apply(null, xs), maxx = Math.max.apply(null, xs), miny = Math.min.apply(null, ys), maxy = Math.max.apply(null, ys);
    var W = 300, H = 210, pad = 26;
    var s = Math.min((W - 2 * pad) / ((maxx - minx) || 1), (H - 2 * pad) / ((maxy - miny) || 1));
    function PX(q) { return (pad + (q.x - minx) * s).toFixed(1); }
    function PY(q) { return (H - pad - (q.y - miny) * s).toFixed(1); }   // y up
    var poly = w.pts.map(function (q) { return PX(q) + ',' + PY(q); }).join(' ');
    var labels = w.legs.map(function (l) {
      var cx = pad + ((l.from.x + l.to.x) / 2 - minx) * s, cy = H - pad - ((l.from.y + l.to.y) / 2 - miny) * s;
      return '<circle cx="' + cx.toFixed(1) + '" cy="' + cy.toFixed(1) + '" r="8" fill="var(--ui-interactive)"/>' +
        '<text x="' + cx.toFixed(1) + '" y="' + (cy + 3).toFixed(1) + '" text-anchor="middle" font-size="9" font-weight="700" fill="#fff">' + l.index + '</text>';
    }).join('');
    var p0 = w.pts[0];
    var pob = '<circle cx="' + PX(p0) + '" cy="' + PY(p0) + '" r="3.5" fill="#A3473B"/>' +
      '<text x="' + PX(p0) + '" y="' + (parseFloat(PY(p0)) - 6).toFixed(1) + '" text-anchor="middle" font-size="8" fill="#A3473B">POB</text>';
    var note = 'Traced from the calls — not to scale, not georeferenced. ' +
      (w.closureFt < 2 ? 'The traverse closes.' : 'Closure gap ≈ ' + w.closureFt + ' ft (the description may start with a tie line or omit a call).');
    return '<div class="pv-xp-diagram"><svg viewBox="0 0 ' + W + ' ' + H + '" style="width:100%;height:auto;display:block" role="img" aria-label="Traced parcel outline with numbered legs">' +
      '<polyline points="' + poly + '" fill="rgba(181,141,74,0.12)" stroke="var(--ui-interactive)" stroke-width="1.5"/>' + labels + pob + '</svg>' +
      '<div class="pv-xp-diag-note">' + note + '</div></div>';
  }

  // The per-call breakdown: numbered legs with a plain-language description (DIC-369
  // Phase 2+). Each leg shows the AI's description when present, else the
  // deterministic gloss, plus the raw bearing/distance.
  function _legItem(c) {
    var tech = [];
    if (c.bearing) tech.push(esc(c.bearing.text));
    if (c.distance) tech.push(esc(c.distance.value + ' ' + c.distance.unit_name) +
      (c.distance.unit !== 'FT' && c.distance.unit !== "'" ? ' / ' + esc(c.distance.feet) + ' ft' : ''));
    var plain = c.ai || c.plain || c.note || '';
    return '<li><span class="pv-xp-leg-n">' + c.index + '</span><div class="pv-xp-leg-body">' +
      '<div class="pv-xp-leg-plain">' + esc(plain) + '</div>' +
      (tech.length ? '<div class="pv-xp-leg-tech">' + tech.join(' · ') + '</div>' : '') + '</div></li>';
  }
  function _mbBreakdown(p) {
    if (!p.courses || !p.courses.length) return '';
    var comm = p.commencement ? '<p class="pv-xp-course-lead">Commences at <span>' + esc(p.commencement) + '</span></p>' : '';
    var legs = '<ul class="pv-xp-legs">' + p.courses.map(_legItem).join('') + '</ul>';
    var close = (p.closings && p.closings.length)
      ? '<ul class="pv-xp-closings">' + p.closings.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ul>' : '';
    return '<div class="pv-xp-hist-cap">Traverse — ' + p.courses.length + ' leg' + (p.courses.length === 1 ? '' : 's') + ' (parsed from the text, not a survey)</div>' +
      _traverseDiagram(p) + comm + legs + close;
  }
  function _kvBreakdown(rows, caption) {
    rows = rows.filter(function (r) { return r[1] != null && r[1] !== '' && !(Array.isArray(r[1]) && !r[1].length); });
    if (!rows.length) return '';
    var trs = rows.map(function (r) {
      var v = Array.isArray(r[1]) ? r[1].join(' of ') : r[1];
      return '<tr><th>' + esc(r[0]) + '</th><td>' + esc(v) + '</td></tr>';
    }).join('');
    return '<div class="pv-xp-hist-cap">' + esc(caption) + '</div><table class="pv-xp-table pv-xp-kv">' + trs + '</table>';
  }
  function _refsHtml(refs) {
    if (!refs || !refs.length) return '';
    var items = refs.map(function (r) {
      return '<li>Liber ' + esc(r.liber) + ', Page ' + esc(r.page) + ' <span class="pv-xp-course-az">(' + esc(r.raw) + ')</span></li>';
    }).join('');
    return '<div class="pv-xp-refs"><div class="pv-xp-hist-cap">Recorded references (deeds / documents)</div>' +
      '<ul class="pv-xp-reflist">' + items + '</ul>' +
      '<div class="pv-xp-diag-note">These Liber/Page numbers point to the recorded deed(s) at the county Register of Deeds — the full legal description lives there.</div></div>';
  }
  function _annosHtml(anns) {
    if (!anns || !anns.length) return '';
    var items = anns.map(function (a) {
      var raw = (a.plain && a.plain !== a.raw) ? ' <span class="pv-xp-course-az">(' + esc(a.raw) + ')</span>' : '';
      return '<li>' + esc(a.plain || a.raw) + raw + '</li>';
    }).join('');
    return '<div class="pv-xp-annos"><div class="pv-xp-hist-cap">Parcel history / notes</div><ul class="pv-xp-annolist">' + items + '</ul></div>';
  }
  function breakdownHtml(parsed) {
    if (!parsed) return '';
    var inner = _refsHtml(parsed.references) + _annosHtml(parsed.annotations);
    if (parsed.kind === 'metes_bounds') inner += _mbBreakdown(parsed);
    else if (parsed.kind === 'aliquot_plss') inner += _kvBreakdown([['Aliquot parts', parsed.quarters], ['Section', parsed.section], ['Town(ship)', parsed.town], ['Range', parsed.range]], 'Structured breakdown (PLSS)');
    else if (parsed.kind === 'platted_lot') inner += _kvBreakdown([['Lot', parsed.lot], ['Block', parsed.block]], 'Structured breakdown (platted lot)');
    return inner ? '<div class="pv-xp-breakdown">' + inner + '</div>' : '';
  }

  function taxDescHeader(facts) {
    return {
      is_taxdesc: true,
      description_text: facts.description_text || '',
      type_label: facts.type_label || '',
      type_note: facts.type_note || '',
      breakdown_html: breakdownHtml(facts.parsed),
    };
  }

  var TOPICS = {
    assessment: {
      label: 'Property Assessment',
      lead: 'A plain-language breakdown of this parcel’s assessment—grounded in the county’s recorded figures.',
      loading: 'Assembling this parcel’s assessment…',
      docSubtitle: 'Property Assessment', docSlug: 'assessment',
      assemble: assembleAssessmentFacts, header: assessmentHeader,
      fallbackTeaser: 'The figures above are this parcel’s recorded values. The AI walkthrough and statute citations couldn’t be reached right now—the educational notes above still apply.',
    },
    tax_description: {
      label: 'Tax Description',
      lead: 'What this parcel’s tax description says, in plain language—and why it isn’t a legal survey.',
      loading: 'Loading this parcel’s tax description…',
      docSubtitle: 'Tax Description', docSlug: 'tax-description',
      assemble: assembleTaxDescriptionFacts, header: taxDescHeader,
      // No teaser when the description itself is empty (handled separately).
      fallbackTeaser: 'The tax description above is this parcel’s recorded text. The AI walkthrough couldn’t be reached right now—the notes above still apply.',
    },
  };

  function buildData(facts, explanation, topic) {
    var meta = TOPICS[topic] || TOPICS.assessment;
    var data = { pin: facts.pin || '', lead: meta.lead, has_ai: !!explanation };
    // Overlay the AI's per-leg descriptions (matched by index) onto the parsed
    // courses, so the numbered legs read in the model's richer language.
    if (topic === 'tax_description' && explanation && explanation.legs && facts.parsed && facts.parsed.courses) {
      var byIndex = {};
      explanation.legs.forEach(function (l) { if (l && l.index != null) byIndex[l.index] = l.description; });
      facts.parsed.courses.forEach(function (c) { if (byIndex[c.index]) c.ai = byIndex[c.index]; });
    }
    var h = meta.header(facts);
    for (var k in h) { if (Object.prototype.hasOwnProperty.call(h, k)) data[k] = h[k]; }
    if (explanation) {
      data.summary_html = explanation.summary ? paras(explanation.summary) : '';
      data.sections = (explanation.sections || []).map(function (s) {
        return { heading: s.heading || '', body_html: paras(s.body) };
      });
      data.glossary = explanation.glossary || [];
      data.has_glossary = !!(explanation.glossary && explanation.glossary.length);
      data.statutes = explanation.statutes || [];
      data.has_statutes = !!(explanation.statutes && explanation.statutes.length);
      data.disclaimer = explanation.disclaimer || '';
    } else {
      data.fallback_items = FALLBACK_ITEMS[topic] || FALLBACK_ITEMS.assessment;
      // Suppress the "offline" teaser when there's simply no content to explain.
      var emptyDesc = topic === 'tax_description' && !facts.description_text;
      if (!emptyDesc) data.fallback_teaser = meta.fallbackTeaser;
    }
    return data;
  }

  function renderHtml(facts, explanation, topic) {
    return T ? T.render(TPL, buildData(facts, explanation, topic)) : '';
  }

  // ── Print / export document ────────────────────────────────────────────────
  var DOC_TPL =
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<title>{{docSubtitle}} — Parcel {{pin}}</title><style>' +
    '*{box-sizing:border-box}body{font:14px/1.55 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1f2937;margin:0;padding:24px;}' +
    '.doc{max-width:760px;margin:0 auto;}' +
    '.dh{display:flex;justify-content:space-between;align-items:baseline;border-bottom:2px solid #A3473B;padding-bottom:8px;margin-bottom:16px;}' +
    '.dh-b{font-weight:700;color:#A3473B;font-size:16px;}.dh-s{font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:#6b7280;}' +
    'h1{font-size:20px;margin:0 0 14px;}h3{font-size:14px;margin:18px 0 4px;color:#A3473B;}' +
    'table{width:100%;border-collapse:collapse;font-size:13.5px;margin-bottom:8px;}th{text-align:left;width:46%;color:#6b7280;font-weight:600;padding:6px 8px;border-bottom:1px solid #eee;vertical-align:top;}td{padding:6px 8px;border-bottom:1px solid #eee;}' +
    'dt{font-weight:700;margin-top:6px;}dd{margin:0 0 4px;color:#4b5563;}' +
    '.cite{color:#6b7280;font-size:12px;}.foot{margin-top:20px;font-size:11px;color:#9ca3af;}' +
    '@media print{body{padding:0;}a{color:inherit;text-decoration:none;}}' +
    '</style></head><body><div class="doc">' +
    '<header class="dh"><span class="dh-b">{{county}}</span><span class="dh-s">{{docSubtitle}}</span></header>' +
    '<h1>Parcel {{pin}}</h1>' +
    '{{#is_assessment}}<table>{{#figures}}<tr><th>{{label}}</th><td>{{value}}</td></tr>{{/figures}}</table>' +
    '{{#history_svg}}<div style="margin:4px 0 12px">{{{history_svg}}}</div>{{/history_svg}}{{/is_assessment}}' +
    '{{#is_taxdesc}}{{#description_text}}<div style="border:1px solid #e5e7eb;border-radius:6px;padding:10px 12px;margin-bottom:10px;font-size:13px;white-space:pre-wrap">{{description_text}}</div>{{/description_text}}' +
      '{{#type_label}}<p class="cite">Detected type: {{type_label}}{{#type_note}} — {{type_note}}{{/type_note}}</p>{{/type_label}}{{{breakdown_html}}}{{/is_taxdesc}}' +
    '{{#has_ai}}{{#summary_text}}<p>{{summary_text}}</p>{{/summary_text}}' +
    '{{#sections}}<h3>{{heading}}</h3><div>{{{body_html}}}</div>{{/sections}}' +
    '{{#has_statutes}}<h3>Michigan law</h3>{{#statutes}}<p><strong>{{name}}</strong> <span class="cite">{{citation}}</span><br>{{plain}}</p>{{/statutes}}{{/has_statutes}}' +
    '{{#disclaimer}}<p class="cite">{{disclaimer}}</p>{{/disclaimer}}{{/has_ai}}' +
    '<footer class="foot">Generated {{generated}} · {{county}} Parcel Viewer · Educational use only.</footer>' +
    '</div></body></html>';

  function docHtml(facts, explanation, topic) {
    if (!T) return '';
    var meta = TOPICS[topic] || TOPICS.assessment;
    var county = (root.COUNTY && root.COUNTY.name) || 'County';
    var d = {
      county: county, pin: facts.pin || '', docSubtitle: meta.docSubtitle,
      has_ai: !!explanation,
      generated: (function () { try { return new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }); } catch (e) { return ''; } })(),
    };
    var h = meta.header(facts);
    for (var k in h) { if (Object.prototype.hasOwnProperty.call(h, k)) d[k] = h[k]; }
    if (d.is_assessment) d.history_svg = historyChartSvg(facts, { doc: true });  // print-safe colors
    if (explanation) {
      d.summary_text = explanation.summary || '';
      d.sections = (explanation.sections || []).map(function (s) { return { heading: s.heading || '', body_html: paras(s.body) }; });
      d.statutes = explanation.statutes || [];
      d.has_statutes = !!(explanation.statutes && explanation.statutes.length);
      d.disclaimer = explanation.disclaimer || '';
    }
    return T.render(DOC_TPL, d);
  }

  function pinSlug(facts) { return String(facts.pin || 'parcel').replace(/[^\w.-]/g, '_'); }

  // ── Orchestration ──────────────────────────────────────────────────────────
  function loadingHtml(meta) {
    return '<div class="pv-xp-loading" role="status">' +
      '<div class="pv-xp-spinner" aria-hidden="true"></div>' +
      '<p>' + esc(meta.loading) + '</p></div>';
  }

  function errorHtml(meta, msg) {
    return '<p class="pv-modal-lead">Couldn’t load this parcel’s ' + esc(meta.label.toLowerCase()) + '.</p>' +
      '<p class="pv-modal-note">' + esc(msg || 'Please try again.') + '</p>';
  }

  function wireActions(bodyEl, facts, explanation, topic, meta) {
    var pr = bodyEl.querySelector('[data-xp="print"]');
    var dl = bodyEl.querySelector('[data-xp="download"]');
    if (pr && root.PV_DOC) pr.addEventListener('click', function () { root.PV_DOC.print(docHtml(facts, explanation, topic)); });
    if (dl && root.PV_DOC) dl.addEventListener('click', function () { root.PV_DOC.downloadHtml(docHtml(facts, explanation, topic), meta.docSlug + '-' + pinSlug(facts) + '.html'); });
  }

  // Generic opener. host = { openModal, closeModal } from admin-menu (modal owner).
  function openExplainer(topic, parcel, host) {
    var meta = TOPICS[topic] || TOPICS.assessment;
    var title = meta.label + (parcel && parcel.pin ? ' — ' + parcel.pin : '');
    host.openModal(title, loadingHtml(meta), function (bodyEl) {
      meta.assemble(parcel)
        .then(function (facts) {
          // No description on record → skip the AI call; show header + notes.
          if (topic === 'tax_description' && !facts.description_text) {
            bodyEl.innerHTML = renderHtml(facts, null, topic);
            wireActions(bodyEl, facts, null, topic, meta);
            return;
          }
          return fetchExplanation(facts, topic).then(function (explanation) {
            bodyEl.innerHTML = renderHtml(facts, explanation, topic);
            wireActions(bodyEl, facts, explanation, topic, meta);
          });
        })
        .catch(function (err) { bodyEl.innerHTML = errorHtml(meta, err && err.message); });
    });
  }

  function openAssessment(parcel, host) { return openExplainer('assessment', parcel, host); }
  function openTaxDescription(parcel, host) { return openExplainer('tax_description', parcel, host); }

  root.PV_EXPLAIN = {
    openAssessment: openAssessment,
    openTaxDescription: openTaxDescription,
    openExplainer: openExplainer,
    // exposed for testing / reuse:
    assembleAssessmentFacts: assembleAssessmentFacts,
    assembleTaxDescriptionFacts: assembleTaxDescriptionFacts,
    classifyDescription: classifyDescription,
    parseDescription: parseDescription,
    fetchExplanation: fetchExplanation,
    renderHtml: renderHtml,
    docHtml: docHtml,
  };
}(typeof window !== 'undefined' ? window : this));
