/**
 * pv-app-context.js — the Parcel Viewer's AppContext bridge (A3 / DIC-568).
 *
 * This is the ONE place that knows the viewer's global names. It builds the injected
 * AppContext singleton (window.PS_CONTEXT) from the live `window.PS_*` / `COUNTY`
 * globals using LIVE getters, so:
 *   - new code reads `PS_CONTEXT.map` / `.config` / `.state` (injection),
 *   - old code + parcel-studio keep reading `window.PS_MAP` etc. (unchanged),
 *   - both see the SAME underlying objects — zero behavior change (strangler-fig).
 *
 * Getters are lazy, so this can load before map.js defines the globals; each access
 * resolves the current value. Migration path: replace `window.PS_X` reads with
 * `PS_CONTEXT.X` file-by-file (see engine/MIGRATION.md). The engine app-context core
 * (ISV_CONTEXT) is source-agnostic; the PS_* knowledge lives only here.
 *
 * Exposes: window.PS_CONTEXT (the injected AppContext), window.PS_BUS (its event bus).
 */
(function (root) {
  'use strict';
  if (!root.ISV_CONTEXT) return;             // engine not loaded → no-op (viewer still works)
  if (root.PS_CONTEXT) return;               // idempotent

  // AC7 (keystone): the viewer's CONFIG resolves from the loaded manifest, not just COUNTY.
  // The manifest carries these "passthrough" blocks verbatim as a COUNTY superset, so a
  // theme can re-skin them. `ctx.config` is a view = COUNTY (base, for keys the manifest
  // doesn't model — name/layers/tools/featureFlags/ai/…) with the manifest's passthrough
  // blocks layered on top. The §5-mapped fields (branding/map/sources/capabilities) already
  // have their own manifest read-points (Phases 1–3), so they stay COUNTY-base here.
  //
  // Strangler-safe by CONSTRUCTION: for the VBC viewer the manifest's blocks are carried from
  // COUNTY, so the view deep-equals COUNTY → zero behavior change (verified live + below). A
  // DIFFERENT theme's blocks now drive the config — which is the whole point of AC7. Before a
  // manifest exists (early boot) it's plain COUNTY, exactly as before.
  var PASSTHROUGH_BLOCKS = ['state', 'parcelNumber', 'labels', 'styling', 'forms', 'endpoints', 'integrations', 'access'];
  var _cfg = null;   // memoized {m, county, view} — rebuilt only when PS_MANIFEST/COUNTY change
  function configView() {
    var county = root.COUNTY || null;
    var m = root.PS_MANIFEST || null;
    if (!m || !county) return county;        // no manifest yet → COUNTY unchanged
    if (_cfg && _cfg.m === m && _cfg.county === county) return _cfg.view;
    var view = Object.assign({}, county);
    for (var i = 0; i < PASSTHROUGH_BLOCKS.length; i++) {
      var b = PASSTHROUGH_BLOCKS[i];
      if (m[b] !== undefined) view[b] = m[b];
    }
    _cfg = { m: m, county: county, view: view };
    return view;
  }

  var ctx = root.ISV_CONTEXT.createAppContext({
    get map() { return root.PS_MAP; },
    get config() { return configView(); },
    get state() { return root.PS_STATE; },
    get prefs() { return root.PV_PREFS; },
    get sourceIndex() { return root.PS_PARCEL_INDEX; },
  });

  root.PS_CONTEXT = ctx;
  root.PS_BUS = ctx.bus;     // shared event bus (A4 selection events land here)
}(typeof window !== 'undefined' ? window : this));
