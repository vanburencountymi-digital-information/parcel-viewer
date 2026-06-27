/**
 * pv-manifest.js — assemble + validate the viewer's manifest at boot (Phase 0 of the
 * manifest-driven engine; builds on C2 / DIC-583 + B2 / DIC-578).
 *
 * Surfaces the engine's loadManifest() AND, on boot, ASSEMBLES a complete theme manifest
 * from the live `window.COUNTY` config (via ISV_MANIFEST_ASSEMBLE) — a superset that also
 * carries the county-specific blocks (parcelNumber / labels / styling / …) so the manifest
 * is the single artifact the viewer can boot from. The validated manifest is published on
 * `window.PS_MANIFEST` (+ PS_MANIFEST_LOADED).
 *
 * ADDITIVE — this changes NO behavior yet: `window.COUNTY` still drives the viewer. This
 * step just proves a schema-valid manifest exists at runtime on the real config and makes
 * it available, so later slices can migrate reads onto it (COUNTY → PS_MANIFEST) one at a
 * time. An explicit window.PS_MANIFEST / COUNTY.manifest still wins over the assembled one.
 *
 * Exposes: window.PV_MANIFEST { load, loadBootManifest }
 */
(function (root) {
  'use strict';

  // County-config blocks with no §5 home of their own — carried onto the manifest verbatim
  // so it's a complete superset of COUNTY. Named HERE (the viewer knows its config shape),
  // keeping the engine assembler source-agnostic.
  var PASSTHROUGH = ['state', 'parcelNumber', 'labels', 'styling', 'forms', 'endpoints', 'integrations', 'access'];

  function engineLoader() {
    return (root.ISV_LOAD_MANIFEST && root.ISV_LOAD_MANIFEST.loadManifest) || null;
  }

  function load(raw) {
    var fn = engineLoader();
    if (!fn) return { ok: false, errors: ['pv-manifest: engine load-manifest.js not loaded'] };
    return fn(raw);
  }

  // Assemble a manifest from the live county config. Null if the assembler isn't loaded.
  function assembleFromCounty(county) {
    var asm = root.ISV_MANIFEST_ASSEMBLE;
    if (!asm || !county) return null;
    return asm.assembleManifest(county, {
      tenant: root.PV_COUNTY_KEY || root.PS_TENANT,   // else the assembler slugs county.name
      idFields: { parcels: 'pin' },
      passthrough: PASSTHROUGH,
    });
  }

  // The raw manifest to boot from: an explicit one if a deployment ships it, else one
  // assembled from COUNTY.
  function bootManifest() {
    if (root.PS_MANIFEST && typeof root.PS_MANIFEST === 'object') return root.PS_MANIFEST;
    if (root.COUNTY && root.COUNTY.manifest && typeof root.COUNTY.manifest === 'object') return root.COUNTY.manifest;
    return assembleFromCounty(root.COUNTY);
  }

  // Assemble/validate at boot; publish window.PS_MANIFEST + PS_MANIFEST_LOADED. Never
  // throws (boot must not break). Returns the load result, or null if nothing to load.
  function loadBootManifest() {
    var raw = bootManifest();
    if (!raw) return null;
    var res = load(raw);
    if (res.ok) {
      root.PS_MANIFEST = res.manifest;          // the validated manifest, available at runtime
      root.PS_MANIFEST_LOADED = res.manifest;
      if (res.applied && res.applied.length && root.console && console.info) {
        console.info('[pv-manifest] migrated manifest ' + res.fromVersion + ' → ' + res.toVersion +
          ' (' + res.applied.join(', ') + ')');
      }
    } else if (root.console && console.warn) {
      console.warn('[pv-manifest] manifest failed to assemble/validate at boot:', (res.errors || []).join('; '));
    }
    return res;
  }

  root.PV_MANIFEST = { load: load, loadBootManifest: loadBootManifest, assembleFromCounty: assembleFromCounty };

  if (root.document && root.document.readyState !== 'loading') {
    loadBootManifest();
  } else if (root.document) {
    root.document.addEventListener('DOMContentLoaded', loadBootManifest);
  }
}(typeof self !== 'undefined' ? self : this));
