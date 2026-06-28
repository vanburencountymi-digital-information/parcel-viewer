/**
 * register.js — register the v1 capabilities into an ISV registry.
 *
 * Two real capabilities, deliberately chosen as opposites so the contract is
 * derived from genuine commonality (§4.10, §6.5):
 *   - explainer : aiMode 'ai-optional', curated-corpus provenance, has narration.
 *   - ledger    : aiMode 'no-ai',       native provenance,         no narration.
 *
 * The explainer's narrate() is a thin seam over an injected transport
 * (`ctx.fetchNarration`) so AI stays a CALLER, never in the core path (§4.3), and
 * the harness can mock it without a live model. In the browser the transport is the
 * real POST /explain; in CI it's a stub.
 *
 * UMD: Node module (harness) + browser global (window.ISV_REGISTER).
 */
(function (root, factory) {
  'use strict';
  var mod = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
  root.ISV_REGISTER = mod;
}(typeof self !== 'undefined' ? self : this, function (root) {
  'use strict';

  function req(nodePath, globalName) {
    if (typeof module !== 'undefined' && module.exports) return require(nodePath);
    return root[globalName];
  }
  var EXPLAINER = req('./explainer.core.js', 'ISV_EXPLAINER_CORE');
  var LEDGER = req('./ledger.core.js', 'ISV_LEDGER_CORE');
  var COMPOSER = req('./theme-composer.core.js', 'ISV_THEME_COMPOSER_CORE');
  var COHORT = req('./cohort-analyze.core.js', 'ISV_COHORT_ANALYZE_CORE');

  // Register the v1 capabilities into the given registry (an ISV.createRegistry()
  // result, or ISV.registry). Returns the registry for chaining.
  function registerAll(registry) {
    registry.register({
      id: 'explainer',
      aiMode: 'ai-optional',
      core: EXPLAINER.core,
      // narrate(facts, provenance, ctx): the AI teacher. Delegates to an injected
      // transport so this layer never imports a model client. Returns the structured
      // explanation, or null to degrade-to-facts (§4.5) — invoke() treats null as a
      // soft failure and leaves narration null without erroring.
      narrate: function (facts, provenance, ctx) {
        if (!ctx || typeof ctx.fetchNarration !== 'function') return null;
        return ctx.fetchNarration(facts, provenance, ctx);
      },
    });

    registry.register({
      id: 'ledger',
      aiMode: 'no-ai',
      core: LEDGER.core,
    });

    registry.register({
      id: 'cohort-analyze',
      aiMode: 'ai-optional',
      core: COHORT.core,
      // narrate(facts, provenance, ctx): the AI "character" read over the deterministic
      // aggregates. Delegates to an injected transport; returns null to degrade-to-facts
      // (AI down → the dashboard/table stands alone, §4.5/§4.6). It must NEVER originate a
      // number — only summarize what facts already contains (grounding-judge gated).
      narrate: function (facts, provenance, ctx) {
        if (!ctx || typeof ctx.fetchCohortNarration !== 'function') return null;
        return ctx.fetchCohortNarration(facts, provenance, ctx);
      },
    });

    registry.register({
      id: 'theme-composer',
      aiMode: 'ai-optional',
      core: COMPOSER.core,
      // narrate(facts, provenance, ctx): the AI refiner. The deterministic core already
      // produced a schema-valid draftManifest (facts); this only adds richer prose
      // rationale + suggested tweaks for the human to review. Delegates to an injected
      // transport; returns null to degrade-to-facts (AI down → the baseline draft stands).
      narrate: function (facts, provenance, ctx) {
        if (!ctx || typeof ctx.fetchComposerNarration !== 'function') return null;
        return ctx.fetchComposerNarration(facts, provenance, ctx);
      },
    });

    return registry;
  }

  return { registerAll: registerAll };
}));
