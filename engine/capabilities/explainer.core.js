/**
 * explainer.core.js — deterministic core of the Explainer capability (A7a / DIC-370,
 * DIC-369), expressed against the A1 contract.
 *
 * This is the "truth" half of the two-engine discipline: pure functions that turn a
 * verified source record into structured FACTS + PROVENANCE, with NO model call and
 * NO globals (§4.3, §6.1). The AI half (narration) lives in map-buddy `run_explain`
 * and may reference ONLY what these functions emit (§4.6 facts-parity).
 *
 * Extracted verbatim-in-behavior from frontend/public/js/pv-explain.js so the viewer
 * and the harness run the SAME code. pv-explain.js now consumes this module.
 *
 * core(typedInput) -> { facts, provenance }
 *   typedInput = { topic, record, labels?, parcelNumber?, statutes? }
 *     topic:        'assessment' | 'tax_description'
 *     record:       the authoritative parcel properties (from /parcel/{id}) — typed
 *                   input, never reached out of global state.
 *     labels:       COUNTY.labels (code→name maps) — config, not code.
 *     parcelNumber: COUNTY.parcelNumber (PIN segment config).
 *     statutes:     curated MI tax-statute corpus (engine/data/mi-tax-statutes.json).
 *
 * UMD: Node module (harness) + browser global (window.ISV_EXPLAINER_CORE).
 */
(function (root, factory) {
  'use strict';
  var mod = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
  root.ISV_EXPLAINER_CORE = mod;
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function num(v) { if (v == null || v === '') return null; var n = Number(v); return isNaN(n) ? null : n; }

  // Resolve a code → label using the county's label maps. style 'code-name' renders
  // "401 – Residential"; otherwise prefer the name, fall back to the code.
  function resolveLabel(labels, mapKey, code, style) {
    code = code != null ? String(code).trim() : null;
    if (!code) return null;
    var name = (labels && labels[mapKey] && labels[mapKey][code]) || null;
    if (!name) return code;
    return style === 'code-name' ? (code + ' – ' + name) : name;
  }

  // ── Deterministic classifier (NO AI): which kind of legal/tax description? ────
  // Never parses geometry; only inspects token shape. (Mirrors pv-explain.js.)
  function classifyDescription(text) {
    var t = (text || '').toUpperCase();
    if (!t.trim()) return { type: 'unknown', label: null, note: '' };
    var hasMB = /\b(COM|COMM|BEG|POB|TH|THENCE)\b/.test(t) ||
      /\d\s*(FT|CHS?|RDS?|LKS?)\b/.test(t) || /\d\s*°/.test(t) ||
      /[NS]\s*\d+[°\s].*\b[EW]\b/.test(t);
    var hasPlat = /\b(LOT|BLK|BLOCK|PLAT)\b/.test(t) || /\b(ADD|SUB|ASSESSOR'?S PLAT)\b/.test(t);
    var hasPLSS = /\bSEC\b/.test(t) || /\bT\d+[NS]\b/.test(t) || /\bR\d+[EW]\b/.test(t) || /1\/4|1\/2/.test(t);
    if (hasMB) return { type: 'metes_bounds', label: 'Metes & bounds', note: 'a traverse of bearings and distances' };
    if (hasPlat) return { type: 'platted_lot', label: 'Platted lot', note: 'a lot within a recorded subdivision' };
    if (hasPLSS) return { type: 'aliquot_plss', label: 'Aliquot / PLSS', note: 'section and quarter divisions' };
    return { type: 'unknown', label: null, note: '' };
  }

  // PIN breakdown — DETERMINISTIC, config-driven (DIC-501). Splits the PIN on the
  // configured separator and zips each part to its segment definition.
  function parsePinSegments(pin, parcelNumberCfg) {
    var cfg = parcelNumberCfg || null;
    if (!cfg || !pin) return null;
    var sep = cfg.separator || '-';
    var parts = String(pin).split(sep).map(function (s) { return s.trim(); })
      .filter(function (s) { return s !== ''; });
    if (parts.length < 2) return null;
    var segs = cfg.segments || [];
    var rows = parts.map(function (val, i) {
      var s = segs[i] || {};
      return { value: val, name: s.name || ('Part ' + (i + 1)), description: s.description || '', extra: i >= segs.length };
    });
    return { separator: sep, intro: cfg.intro || '', parts: rows };
  }

  // ── Fact assembly (pure) ────────────────────────────────────────────────────
  function buildAssessmentFacts(record, ctx) {
    var p = record || {};
    var labels = (ctx && ctx.labels) || null;
    var av = num(p.assessed_value);
    // DB stores assessed_value_yr0..yr4 newest-first.
    var histNewestFirst = [p.assessed_value_yr0, p.assessed_value_yr1, p.assessed_value_yr2,
                           p.assessed_value_yr3, p.assessed_value_yr4].map(num);
    var oldestFirst = histNewestFirst.slice().reverse();
    var curYear = (ctx && ctx.currentYear) || _thisYear();
    var n = oldestFirst.length;
    var byYear = oldestFirst.map(function (v, i) {
      return { year: curYear - (n - 1 - i), assessed_value: v };
    }).filter(function (e) { return e.assessed_value != null; });
    return {
      pin: p.pin || p.parcel_no || (ctx && ctx.pinFallback) || '',
      owner_name: p.owner_name || null,
      municipality: p.municipality || null,
      school_district: resolveLabel(labels, 'schoolDist', p.school_dist, 'name'),
      classification: resolveLabel(labels, 'propClass', p.prop_class, 'code-name'),
      pre_percent: num(p.homestead),
      assessed_value: av,
      prev_assessed_value: num(p.prev_assessed_value),
      taxable_value: num(p.taxable_value),
      prev_taxable_value: num(p.prev_taxable_value),
      true_cash_value_estimate: av != null ? av * 2 : null,
      assessed_value_history: histNewestFirst,
      assessed_value_by_year: byYear,
    };
  }

  function buildTaxDescriptionFacts(record, ctx) {
    var p = record || {};
    var text = p.ps_legal_description || p.legal_description || '';
    var cls = classifyDescription(text);
    var pin = p.pin || p.parcel_no || (ctx && ctx.pinFallback) || '';
    var breakdown = parsePinSegments(pin, ctx && ctx.parcelNumber);
    return {
      pin: pin,
      tax_id: p.pin || p.parcel_no || '',
      description_text: text,
      description_type: cls.type,
      type_label: cls.label,
      type_note: cls.note,
      pin_breakdown: breakdown,
      parcel_number_parts: breakdown ? breakdown.parts.map(function (r) {
        return { part: r.value, name: r.name, description: r.description };
      }) : null,
    };
  }

  // ── Provenance (§6.4 citation envelope) ─────────────────────────────────────
  // Assessment: the citable universe IS the curated statute corpus — exactly what
  // the AI narrator is allowed to cite (§4.6 made literal). AI-off renders these as
  // links; AI-on cites only from this same set.
  function assessmentProvenance(statutes) {
    return (statutes || []).map(function (s) {
      return {
        source_id: s.citation || s.name,
        anchor: s.mcl || null,
        span: s.name || null,
        state: s.state || 'coarse',
        // extra display fields the Citation Renderer / fallback link list can use
        url: s.url || null, plain: s.plain || null,
      };
    });
  }

  // Tax description: the recorded text itself is the provenance — the assessment
  // roll is the source, the parcel's tax id the anchor. 'coarse' until the KB
  // pipeline gives a resolvable locator into the roll.
  function taxDescriptionProvenance(facts) {
    if (!facts || !facts.description_text) return [];
    return [{
      source_id: 'assessment-roll',
      anchor: facts.tax_id || facts.pin || null,
      span: 'tax description',
      state: 'coarse',
    }];
  }

  // ── Contract core: core(typedInput) -> { facts, provenance } ────────────────
  function core(input) {
    input = input || {};
    var topic = input.topic || 'assessment';
    var ctx = { labels: input.labels, parcelNumber: input.parcelNumber,
                pinFallback: input.pinFallback, currentYear: input.currentYear };
    if (topic === 'assessment') {
      var af = buildAssessmentFacts(input.record, ctx);
      return { facts: af, provenance: assessmentProvenance(input.statutes) };
    }
    if (topic === 'tax_description') {
      var tf = buildTaxDescriptionFacts(input.record, ctx);
      return { facts: tf, provenance: taxDescriptionProvenance(tf) };
    }
    throw new Error('explainer core: unsupported topic ' + topic);
  }

  function _thisYear() {
    // Isolated so the harness can pass a fixed currentYear and stay deterministic.
    return new Date().getFullYear();
  }

  return {
    core: core,
    buildAssessmentFacts: buildAssessmentFacts,
    buildTaxDescriptionFacts: buildTaxDescriptionFacts,
    classifyDescription: classifyDescription,
    parsePinSegments: parsePinSegments,
    assessmentProvenance: assessmentProvenance,
    taxDescriptionProvenance: taxDescriptionProvenance,
  };
}));
