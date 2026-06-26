/**
 * capability-catalog.js — the platform's capability VOCABULARY (data, not logic).
 *
 * The Theme Composer (B2 / DIC-578) needs a catalog of the capabilities a theme can
 * enable, each with its DEFAULT AI tri-state (§4.7: no-ai | ai-optional | ai-required)
 * and disclosure level (basic | advanced | hidden). This is the piece "no existing
 * console module owns" (§7) — capability selection + per-capability AI mode.
 *
 * This is deliberately a DATA module (like engine/data/*.json or the manifest fixtures),
 * NOT engine logic — so it legitimately carries the manifest's domain vocabulary (e.g.
 * the spec-defined `parcelInfo` capability id, §5.1) without violating the source-agnostic
 * invariant that governs ENGINE CODE (§4.1). The assembler (manifest-assemble.js) stays
 * noun-free and reads this catalog generically.
 *
 * Source of truth: ISV_BUILD_SPEC §5.1 capabilities block. Keep in sync with the manifest
 * schema. A theme's manifest.capabilities is a SUBSET of these ids; absent = not enabled.
 *
 * UMD: Node module (harness) + browser global (window.ISV_CAPABILITY_CATALOG).
 */
(function (root, factory) {
  'use strict';
  var mod = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
  root.ISV_CAPABILITY_CATALOG = mod;
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Each entry: { id, ai (default tri-state), disclosure, label }. `ai` is the SUGGESTED
  // default a theme starts from; the author can override per-capability in the composer.
  var CATALOG = [
    { id: 'search',         ai: 'no-ai',       disclosure: 'basic',    label: 'Search' },
    { id: 'parcelInfo',     ai: 'no-ai',       disclosure: 'basic',    label: 'Feature info panel' },
    { id: 'layers',         ai: 'no-ai',       disclosure: 'basic',    label: 'Layer control' },
    { id: 'drawing',        ai: 'no-ai',       disclosure: 'advanced', label: 'Drawing & annotation' },
    { id: 'measure',        ai: 'no-ai',       disclosure: 'advanced', label: 'Measure' },
    { id: 'explainer',      ai: 'ai-optional', disclosure: 'basic',    label: 'Explainer' },
    { id: 'visionDescribe', ai: 'ai-optional', disclosure: 'advanced', label: 'Vision describe' },
    { id: 'cogo',           ai: 'ai-optional', disclosure: 'advanced', label: 'COGO traverse' },
    { id: 'ledger',         ai: 'no-ai',       disclosure: 'advanced', label: 'Ledger / history' },
    { id: 'mapBuddy',       ai: 'ai-optional', disclosure: 'basic',    label: 'Map Buddy chat' },
    { id: 'print',          ai: 'no-ai',       disclosure: 'basic',    label: 'Print' },
    { id: 'share',          ai: 'no-ai',       disclosure: 'basic',    label: 'Share' },
    { id: 'citations',      ai: 'ai-optional', disclosure: 'advanced', label: 'Citations' },
  ];

  function byId(id) {
    for (var i = 0; i < CATALOG.length; i++) if (CATALOG[i].id === id) return CATALOG[i];
    return null;
  }

  // Build a manifest.capabilities object enabling the given ids (default: ALL), each at
  // its catalog-default AI mode + disclosure. Pass `overrides` (id → partial cfg) to set
  // a per-capability ai/disclosure. Unknown ids are skipped (catalog is the vocabulary).
  function defaultCapabilities(ids, overrides) {
    var enabled = Array.isArray(ids) ? ids : CATALOG.map(function (c) { return c.id; });
    var ov = overrides || {};
    var out = {};
    enabled.forEach(function (id) {
      var spec = byId(id);
      if (!spec) return;
      var cfg = { ai: spec.ai };
      if (spec.disclosure) cfg.disclosure = spec.disclosure;
      if (ov[id] && ov[id].ai) cfg.ai = ov[id].ai;
      if (ov[id] && ov[id].disclosure) cfg.disclosure = ov[id].disclosure;
      out[id] = cfg;
    });
    return out;
  }

  return {
    CATALOG: CATALOG.slice(),
    ids: function () { return CATALOG.map(function (c) { return c.id; }); },
    byId: byId,
    defaultCapabilities: defaultCapabilities,
  };
}));
