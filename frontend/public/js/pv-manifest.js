/**
 * pv-manifest.js — viewer bridge for the migrate-on-load seam (C2 / DIC-583).
 *
 * Surfaces the engine's canonical loadManifest() (engine/load-manifest.js) to the browser
 * so any future consumer — Theme Composer (B2), the Admin Console store, engine boot —
 * turns a RAW stored manifest into a migrated + validated one through ONE entry point:
 *
 *     PV_MANIFEST.load(raw) -> { ok, manifest, fromVersion, toVersion, applied, errors }
 *
 * This is deliberately ADDITIVE and non-enforcing today. `window.COUNTY` is the live
 * county config, NOT a §5 theme manifest (no manifestVersion/sources/capabilities in the
 * v1.0 shape), so running migrate-on-load against COUNTY would only produce spurious
 * validation errors. Until B2 produces a real theme manifest, the boot hook runs the seam
 * ONLY when an explicit manifest is present (window.PS_MANIFEST or COUNTY.manifest) and is
 * otherwise a silent no-op — boot behavior is unchanged. When a manifest IS present, it is
 * migrated-on-load and the upgraded result is published on window.PS_MANIFEST_LOADED for
 * downstream consumers; a failure is logged, never thrown (boot must not break).
 *
 * Exposes: window.PV_MANIFEST { load, loadBootManifest }
 */
(function (root) {
  'use strict';

  function engineLoader() {
    return (root.ISV_LOAD_MANIFEST && root.ISV_LOAD_MANIFEST.loadManifest) || null;
  }

  // Run a raw manifest through the engine seam. If the engine bundle didn't load, return
  // a clear failure rather than passing an unmigrated/unvalidated manifest downstream.
  function load(raw) {
    var fn = engineLoader();
    if (!fn) return { ok: false, errors: ['pv-manifest: engine load-manifest.js not loaded'] };
    return fn(raw);
  }

  // The boot manifest, if a deployment has one. COUNTY is NOT it (see file header).
  function bootManifest() {
    if (root.PS_MANIFEST && typeof root.PS_MANIFEST === 'object') return root.PS_MANIFEST;
    if (root.COUNTY && root.COUNTY.manifest && typeof root.COUNTY.manifest === 'object') return root.COUNTY.manifest;
    return null;
  }

  // Migrate-on-load at boot — only when an explicit manifest exists. Publishes the
  // migrated manifest on window.PS_MANIFEST_LOADED. Returns the load result (or null
  // when there's nothing to load). Never throws.
  function loadBootManifest() {
    var raw = bootManifest();
    if (!raw) return null;   // no theme manifest yet — silent no-op (boot unchanged)
    var res = load(raw);
    if (res.ok) {
      root.PS_MANIFEST_LOADED = res.manifest;
      if (res.applied && res.applied.length && root.console && console.info) {
        console.info('[pv-manifest] migrated manifest ' + res.fromVersion + ' → ' + res.toVersion +
          ' (' + res.applied.join(', ') + ')');
      }
    } else if (root.console && console.warn) {
      console.warn('[pv-manifest] manifest failed migrate-on-load:', (res.errors || []).join('; '));
    }
    return res;
  }

  root.PV_MANIFEST = { load: load, loadBootManifest: loadBootManifest };

  // Run once at boot, after config + engine scripts are in (ordered <script> tags).
  if (root.document && root.document.readyState !== 'loading') {
    loadBootManifest();
  } else if (root.document) {
    root.document.addEventListener('DOMContentLoaded', loadBootManifest);
  }
}(typeof self !== 'undefined' ? self : this));
