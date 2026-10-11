/**
 * feature-flags.js — per-tenant feature flags (C4 / DIC-585).
 *
 * One engine behind N county viewers means a new capability shouldn't go live everywhere
 * at once. Feature flags gate capabilities PER TENANT for staged rollout (enable a new
 * capability for one county first) and fast per-tenant rollback (disable it for one county
 * without republishing its manifest). Per §4 + the ticket: REUSE the manifest capability +
 * AI tri-state primitives — this is an override layer over them, not a new flag system.
 *
 * A flags object maps capabilityId → override:
 *   - `false`            → gate the capability OFF for this tenant (rollback / not-yet-rolled).
 *   - `true`             → force the capability ON (canary a capability not in the manifest),
 *                          using its catalog default config.
 *   - { ai?, disclosure?}→ override the capability's config (e.g. flip a tenant to ai-off).
 * A capability with no flag keeps its manifest config unchanged.
 *
 * resolveCapabilities(manifest, flags) -> a new capabilities map (manifest untouched).
 *
 * ES module (DIC-2180): imported by the harness and, in the browser, put on
 * window.ISV_FEATURE_FLAGS by engine/window-hooks.js.
 */
import CATALOG from './capability-catalog.js';

const mod = (function () {
  'use strict';

  function catalogDefault(id) {
    var spec = CATALOG && CATALOG.byId(id);
    if (!spec) return { ai: 'no-ai' };
    var cfg = { ai: spec.ai };
    if (spec.disclosure) cfg.disclosure = spec.disclosure;
    return cfg;
  }

  // Apply per-tenant flags to a manifest's capabilities. Returns a NEW capabilities map.
  function resolveCapabilities(manifest, flags) {
    var caps = {};
    var src = (manifest && manifest.capabilities) || {};
    for (var k in src) if (Object.prototype.hasOwnProperty.call(src, k)) {
      caps[k] = { ai: src[k].ai, disclosure: src[k].disclosure };
    }
    flags = flags || {};
    Object.keys(flags).forEach(function (id) {
      var f = flags[id];
      if (f === false) { delete caps[id]; return; }               // gate OFF
      if (f === true) { caps[id] = caps[id] || catalogDefault(id); return; }  // force ON (canary)
      if (f && typeof f === 'object') {                            // override config
        var base = caps[id] || catalogDefault(id);
        caps[id] = { ai: f.ai != null ? f.ai : base.ai,
                     disclosure: f.disclosure != null ? f.disclosure : base.disclosure };
      }
    });
    // Drop undefined disclosure keys so the shape matches a plain manifest capability.
    Object.keys(caps).forEach(function (id) { if (caps[id].disclosure == null) delete caps[id].disclosure; });
    return caps;
  }

  // Apply flags and return a NEW manifest (capabilities replaced). The input is untouched.
  function applyFlags(manifest, flags) {
    var out = {};
    for (var k in manifest) if (Object.prototype.hasOwnProperty.call(manifest, k)) out[k] = manifest[k];
    out.capabilities = resolveCapabilities(manifest, flags);
    return out;
  }

  function isEnabled(manifest, capabilityId, flags) {
    return Object.prototype.hasOwnProperty.call(resolveCapabilities(manifest, flags), capabilityId);
  }

  return { resolveCapabilities: resolveCapabilities, applyFlags: applyFlags, isEnabled: isEnabled };
})();

export { mod as default, mod as 'module.exports' };
