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

  var ctx = root.ISV_CONTEXT.createAppContext({
    get map() { return root.PS_MAP; },
    get config() { return root.COUNTY; },
    get state() { return root.PS_STATE; },
    get prefs() { return root.PV_PREFS; },
    get sourceIndex() { return root.PS_PARCEL_INDEX; },
  });

  root.PS_CONTEXT = ctx;
  root.PS_BUS = ctx.bus;     // shared event bus (A4 selection events land here)
}(typeof window !== 'undefined' ? window : this));
