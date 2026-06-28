/**
 * ai-quality.js — citation-accuracy + grounding checks for AI output (C5 / DIC-586).
 *
 * Separate from the deterministic harness (A2): AI output is non-deterministic, but its
 * TRUST PROPERTIES are checkable deterministically. Given a capability's structured AI
 * output plus the facts + corpus it was supposed to narrate from, this verifies the two
 * things that make a government AI surface trustworthy (§4.8, §6.4, the "narrate, never
 * originate" discipline):
 *
 *   1. Citation accuracy — every statute the narration cites EXISTS in the curated
 *      corpus (no hallucinated law). Anchored on the MCL number, format-tolerant.
 *   2. Grounding — every dollar amount in the narration traces to a verified figure in
 *      the facts (no originated values). Conceptual numbers (50%, 5%, years) are not
 *      dollar amounts and aren't policed here.
 *
 * Runs in CI on golden/mock examples — no live model. The LLM-judge gate for prompt/
 * model changes is a separate, heavier layer; this is the cheap automated floor.
 *
 * UMD: Node module (harness) + browser global (window.ISV_AI_QUALITY).
 */
(function (root, factory) {
  'use strict';
  var mod = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
  root.ISV_AI_QUALITY = mod;
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Extract MCL "cores" (e.g. 211.27a, 205.731, 211.7cc) from any citation text,
  // dropping subsection parens so "MCL 211.27a(2)" and "211.27a" match.
  function mclCores(str) {
    var m = String(str == null ? '' : str).match(/\d{3}\.\d+[a-z]*/g) || [];
    return m.map(function (s) { return s.toLowerCase(); });
  }

  function corpusCores(corpus) {
    var set = Object.create(null);
    (corpus || []).forEach(function (s) {
      mclCores(s.citation).forEach(function (c) { set[c] = 1; });
      mclCores(s.mcl).forEach(function (c) { set[c] = 1; });
    });
    return set;
  }

  // Citation accuracy: every cited statute must resolve to an MCL present in the corpus.
  // A citation with no MCL-shaped token is treated as unverifiable → a violation (an
  // uncitable claim is freelancing, §6.4).
  function checkCitations(citedStatutes, corpus) {
    var allowed = corpusCores(corpus);
    var violations = [];
    (citedStatutes || []).forEach(function (st) {
      var cores = mclCores(st && st.citation);
      if (!cores.length) {
        violations.push({ citation: (st && st.citation) || '(none)', reason: 'no resolvable MCL' });
        return;
      }
      cores.forEach(function (c) {
        if (!allowed[c]) violations.push({ citation: st.citation, mcl: c, reason: 'not in corpus' });
      });
    });
    return { ok: violations.length === 0, violations: violations };
  }

  function dollarsIn(text) {
    return (String(text == null ? '' : text).match(/\$\s?[\d,]+/g) || [])
      .map(function (s) { return parseInt(s.replace(/[$,\s]/g, ''), 10); })
      .filter(function (n) { return !isNaN(n); });
  }

  // The set of dollar values the narration is allowed to state — the verified figures
  // and the clearly-labeled derivations the explainer may restate (TCV = 2×AV).
  function groundedDollarSet(facts) {
    var set = Object.create(null);
    function add(v) { var n = Math.round(Number(v)); if (!isNaN(n)) set[n] = 1; }
    ['assessed_value', 'prev_assessed_value', 'taxable_value', 'prev_taxable_value', 'true_cash_value_estimate'].forEach(function (k) {
      if (facts && facts[k] != null) add(facts[k]);
    });
    (facts && facts.assessed_value_history || []).forEach(function (v) { if (v != null) add(v); });
    if (facts && facts.assessed_value != null) add(facts.assessed_value * 2);        // TCV
    if (facts && facts.prev_assessed_value != null) add(facts.prev_assessed_value * 2);
    return set;
  }

  // Grounding: every dollar amount in the narration must be a verified figure.
  function checkGrounding(text, facts) {
    var allowed = groundedDollarSet(facts);
    var violations = [];
    dollarsIn(text).forEach(function (n) {
      if (!allowed[n]) violations.push({ amount: n, reason: 'not in verified figures' });
    });
    return { ok: violations.length === 0, violations: violations };
  }

  // Flatten an explainer-shaped output to one searchable string.
  function explanationText(out) {
    if (!out) return '';
    var parts = [out.summary || ''];
    (out.sections || []).forEach(function (s) { parts.push(s.heading || '', s.body || ''); });
    (out.glossary || []).forEach(function (g) { parts.push(g.term || '', g.definition || ''); });
    (out.statutes || []).forEach(function (s) { parts.push(s.name || '', s.plain || ''); });
    parts.push(out.disclaimer || '');
    return parts.join('\n');
  }

  // Evaluate an explainer output against the facts + corpus it narrated from.
  function evaluateExplanation(output, ctx) {
    ctx = ctx || {};
    var citations = checkCitations(output && output.statutes, ctx.corpus);
    var grounding = checkGrounding(explanationText(output), ctx.facts);
    return { ok: citations.ok && grounding.ok, citations: citations, grounding: grounding };
  }

  // ── Cohort narration grounding (DIC-588) ────────────────────────────────────
  // The cohort "character" read narrates the deterministic profile (composition /
  // value-stats / value-change / ownership). Same discipline as the explainer: any
  // dollar amount it states must be a figure the engine core already computed — the
  // model characterizes, it never originates a number (§4.6). The allowed set is every
  // dollar-valued statistic in the cohort facts (sums/means/medians/min/max/per-area +
  // change totals). Shares/percentages and counts are not dollars and aren't policed here.
  function cohortDollarSet(facts) {
    var set = Object.create(null);
    function add(v) { var n = Math.round(Number(v)); if (!isNaN(n)) set[n] = 1; }
    var vs = (facts && facts.valueStats) || {};
    Object.keys(vs).forEach(function (k) {
      var s = vs[k] || {};
      ['sum', 'mean', 'median', 'min', 'max', 'perArea'].forEach(function (f) { if (s[f] != null) add(s[f]); });
    });
    var vc = (facts && facts.valueChange) || {};
    Object.keys(vc).forEach(function (k) {
      var c = vc[k] || {};
      ['currentTotal', 'priorTotal', 'deltaTotal'].forEach(function (f) { if (c[f] != null) add(c[f]); });
    });
    return set;
  }

  // Grounding: every dollar amount in the cohort narration must be a verified figure.
  function checkCohortGrounding(text, facts) {
    var allowed = cohortDollarSet(facts);
    var violations = [];
    dollarsIn(text).forEach(function (n) {
      if (!allowed[n]) violations.push({ amount: n, reason: 'not in cohort figures' });
    });
    return { ok: violations.length === 0, violations: violations };
  }

  // Flatten a cohort-narration output ({headline, character, paragraphs, caveats}) to one string.
  function cohortText(out) {
    if (!out) return '';
    var parts = [out.headline || '', out.character || ''];
    (out.paragraphs || []).forEach(function (p) { parts.push(p || ''); });
    (out.caveats || []).forEach(function (c) { parts.push(c || ''); });
    return parts.join('\n');
  }

  // Evaluate a cohort narration against the deterministic facts it narrated from.
  function evaluateCohortNarration(output, ctx) {
    ctx = ctx || {};
    var grounding = checkCohortGrounding(cohortText(output), ctx.facts);
    return { ok: grounding.ok, grounding: grounding };
  }

  // ── Generic §6.4 citation-envelope check (any capability, not just the explainer) ──
  var ENVELOPE_STATES = { resolves: 1, coarse: 1, none: 1 };

  // Validate provenance emitted in the shared citation envelope (§6.4):
  //   { source_id, anchor, span, state: 'resolves'|'coarse'|'none' }
  // `validSources` (optional array) is the set a 'resolves' citation may point at; a
  // 'resolves' citation to an unknown source is a HALLUCINATED source. A 'none' state is
  // an uncitable claim — freelancing (§6.4), a violation. 'coarse' is honest degradation.
  function checkEnvelope(citations, validSources) {
    var allow = null;
    if (Array.isArray(validSources)) {
      allow = {};
      validSources.forEach(function (s) { allow[s] = 1; });
    }
    var violations = [];
    (citations || []).forEach(function (c, i) {
      var at = (c && c.anchor) || ('#' + i);
      if (!c || !c.source_id) { violations.push({ anchor: at, reason: 'missing source_id' }); return; }
      if (!c.span) violations.push({ anchor: at, reason: 'missing span' });
      if (!ENVELOPE_STATES[c.state]) { violations.push({ anchor: at, reason: 'invalid state: ' + c.state }); return; }
      if (c.state === 'none') { violations.push({ anchor: at, reason: 'uncitable claim (state none = freelancing)' }); return; }
      if (allow && c.state === 'resolves' && !allow[c.source_id]) {
        violations.push({ anchor: at, source_id: c.source_id, reason: 'cited source not in the allowed set' });
      }
    });
    return { ok: violations.length === 0, violations: violations };
  }

  // Quality gate for the theme-composer (B3): the draft must be fully GROUNDED — every
  // enabled capability and the persona trace to a provenance entry (no capability
  // appears without a documented reason), and the provenance envelope is well-formed.
  function evaluateComposer(output, opts) {
    opts = opts || {};
    var facts = (output && output.facts) || {};
    var manifest = facts.draftManifest || {};
    var prov = (output && output.provenance) || [];

    var envelope = checkEnvelope(prov, opts.validSources || ['brief']);

    var anchored = {};
    prov.forEach(function (c) { if (c && c.anchor) anchored[c.anchor] = 1; });
    var violations = [];
    Object.keys(manifest.capabilities || {}).forEach(function (id) {
      if (!anchored['capabilities.' + id]) {
        violations.push({ capability: id, reason: 'enabled but no provenance — ungrounded' });
      }
    });
    if (manifest.persona && !anchored['persona.audience']) {
      violations.push({ reason: 'persona set but no provenance' });
    }
    var grounding = { ok: violations.length === 0, violations: violations };
    return { ok: envelope.ok && grounding.ok, envelope: envelope, grounding: grounding };
  }

  return {
    checkCitations: checkCitations,
    checkGrounding: checkGrounding,
    evaluateExplanation: evaluateExplanation,
    checkCohortGrounding: checkCohortGrounding,
    evaluateCohortNarration: evaluateCohortNarration,
    checkEnvelope: checkEnvelope,
    evaluateComposer: evaluateComposer,
    mclCores: mclCores,
    dollarsIn: dollarsIn,
  };
}));
