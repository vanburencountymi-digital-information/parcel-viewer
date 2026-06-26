/**
 * pv-selection.js — Parcel Viewer selection bridge (A4 / DIC-569).
 *
 * Creates the engine SelectionManager on the shared bus (PS_BUS), exposed as
 * window.PS_SELECTION. map.js drives it EXPLICITLY at its selection sites
 * (PS_SELECTION.select(ref) on select, PS_SELECTION.clear() on deselect), so the bus
 * carries the full selection stream. New subscribers do
 * `PS_BUS.on('selection-changed', …)` instead of reaching into window.PS_STATE.
 *
 * History: an earlier slice intercepted `window.PS_onParcelSelect` to mirror
 * selections without touching map.js. That recursed against hints.js (which also wraps
 * that hook), so it was replaced by explicit driving from map.js — which also leaves
 * parcel-studio's PS_onParcelSelect completely untouched.
 *
 * Exposes: window.PS_SELECTION (the SelectionManager), window.PS_BUS (its bus,
 * also set by pv-app-context.js — this is idempotent).
 */
(function (root) {
  'use strict';
  if (!root.ISV_SELECTION || !root.PS_BUS) return;   // engine/bridge not loaded → no-op
  if (root.PS_SELECTION) return;                      // idempotent

  root.PS_SELECTION = root.ISV_SELECTION.createSelectionManager({
    bus: root.PS_BUS,
    defaultSourceId: 'parcels',
  });
}(typeof window !== 'undefined' ? window : this));
