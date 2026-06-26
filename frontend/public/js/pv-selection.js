/**
 * pv-selection.js — Parcel Viewer selection bridge (A4 / DIC-569, slice 1).
 *
 * Slice 1 is ADDITIVE and touches NO map.js code. It:
 *   1. creates the engine SelectionManager on the shared bus (PS_BUS), exposed as
 *      window.PS_SELECTION, and
 *   2. MIRRORS the viewer's existing selection onto the bus by intercepting the
 *      `window.PS_onParcelSelect` hook the map already calls on every selection
 *      (map.js ≈ line 1675) — WITHOUT removing it. The interception preserves any
 *      downstream handler (e.g. parcel-studio's), so both still run.
 *
 * New subscribers can now do `PS_BUS.on('selection-changed', …)` instead of reaching
 * into window.PS_STATE. Old code + parcel-studio are unaffected. Later A4 slices route
 * map.js feature-state rendering and the info panel through these events and emit
 * clears too (the hook isn't called on deselect, so slice 1 mirrors selects only).
 *
 * Exposes: window.PS_SELECTION (the SelectionManager).
 */
(function (root) {
  'use strict';
  if (!root.ISV_SELECTION || !root.PS_BUS) return;   // engine/bridge not loaded → no-op
  if (root.PS_SELECTION) return;                      // idempotent

  var sel = root.ISV_SELECTION.createSelectionManager({ bus: root.PS_BUS, defaultSourceId: 'parcels' });
  root.PS_SELECTION = sel;

  // Map the viewer's selected-parcel object → the engine's feature ref. id-first
  // (works for any feature); pin is the human key, kept in properties.
  function toRef(parcel) {
    if (!parcel) return null;
    return {
      sourceId: 'parcels',
      id: parcel.id != null ? parcel.id : (parcel.pin != null ? parcel.pin : null),
      properties: parcel,
    };
  }

  // Non-invasive interception of the PS_onParcelSelect hook. Defined as an accessor so
  // that whoever ASSIGNS the hook (e.g. parcel-studio: `PS_onParcelSelect = fn`) is
  // captured as the downstream handler, while READS of the hook (the map's call site)
  // get our dispatcher — which mirrors onto the bus and then calls downstream.
  var downstream = (typeof root.PS_onParcelSelect === 'function') ? root.PS_onParcelSelect : null;

  function dispatcher(parcel) {
    try { sel.select(toRef(parcel)); } catch (e) { if (root.console) root.console.error(e); }
    if (typeof downstream === 'function') {
      try { downstream(parcel); } catch (e) { if (root.console) root.console.error(e); }
    }
  }

  try {
    Object.defineProperty(root, 'PS_onParcelSelect', {
      configurable: true,
      get: function () { return dispatcher; },
      set: function (fn) { downstream = (typeof fn === 'function') ? fn : null; },
    });
  } catch (e) {
    // Fallback: if the accessor can't be installed, just set the dispatcher (still
    // mirrors; a later-assigned downstream would replace it — acceptable degrade).
    root.PS_onParcelSelect = dispatcher;
  }
}(typeof window !== 'undefined' ? window : this));
