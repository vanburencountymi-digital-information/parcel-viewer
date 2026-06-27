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
  // Idempotent: once a manifest is published, repeat calls are no-ops (we run BOTH eagerly
  // at parse time — so PS_MANIFEST exists before map.js initMap() — and again on
  // DOMContentLoaded as a safety net if the engine deps weren't ready at parse time).
  function loadBootManifest() {
    if (root.PS_MANIFEST_LOADED) return { ok: true, manifest: root.PS_MANIFEST_LOADED };
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

  // ── Source accessors (Phase 3): the single read-point for manifest sources, reused by the
  //    layer modules (pg-layers, layer-registry) with a COUNTY fallback at the call site. ──
  function sources() {
    var m = root.PS_MANIFEST;
    return (m && Array.isArray(m.sources)) ? m.sources : null;
  }
  function source(id) {
    var ss = sources();
    if (!ss) return null;
    for (var i = 0; i < ss.length; i++) if (ss[i] && ss[i].id === id) return ss[i];
    return null;
  }
  // Sources carrying a given role ('base' | 'overlay' | 'county-overlay'). Null (not [])
  // when no manifest, so callers can distinguish "no manifest" → use COUNTY.
  function sourcesByRole(role) {
    var ss = sources();
    if (!ss) return null;
    return ss.filter(function (s) { return s && s.role === role; });
  }
  // The toggleable vector overlays (role 'overlay', type vector) — the set pg-layers renders.
  function vectorOverlays() {
    var ss = sources();
    if (!ss) return null;
    return ss.filter(function (s) {
      return s && s.role === 'overlay' && String(s.type || '').toLowerCase() === 'vector';
    });
  }

  root.PV_MANIFEST = {
    load: load, loadBootManifest: loadBootManifest, assembleFromCounty: assembleFromCounty,
    sources: sources, source: source, vectorOverlays: vectorOverlays, sourcesByRole: sourcesByRole,
  };

  // Assemble EAGERLY at parse time: this script now loads after county-config.js + the engine
  // modules but BEFORE map.js, so window.PS_MANIFEST is published before initMap() reads it
  // (Phase 1 routes branding/map/scheme reads through the manifest). If the eager pass found
  // nothing to load (e.g. a dep wasn't ready), retry on DOMContentLoaded — idempotent.
  var eager = loadBootManifest();
  if ((!eager || !eager.ok) && root.document && root.document.readyState === 'loading') {
    root.document.addEventListener('DOMContentLoaded', loadBootManifest);
  }
}(typeof self !== 'undefined' ? self : this));
