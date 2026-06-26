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

  return {
    checkCitations: checkCitations,
    checkGrounding: checkGrounding,
    evaluateExplanation: evaluateExplanation,
    mclCores: mclCores,
    dollarsIn: dollarsIn,
  };
}));
