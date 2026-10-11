/**
 * selection.js — feature-agnostic SelectionManager (A4 / DIC-569, slice 1).
 *
 * The selection state machine, lifted OUT of the map runtime and made testable in
 * isolation. It knows "a selected feature" and "an active (hover/focus) feature" —
 * a feature being `{ sourceId, id, properties? }`, never a hardcoded domain key
 * (§4.1). It owns no DOM and no map; it only tracks state and announces changes on
 * the injected event bus:
 *   - 'selection-changed'      { ref, previous }
 *   - 'active-feature-changed' { ref, previous }
 *
 * Rendering (MapLibre feature-state) and the info panel SUBSCRIBE to these instead of
 * being fused into one function — that decoupling is the rest of A4. Slice 1 ships the
 * manager + a non-invasive bridge that mirrors the viewer's existing selection onto
 * the bus, with no surgery to map.js yet.
 *
 * ES module (DIC-2180): imported by the harness and, in the browser, put on
 * window.ISV_SELECTION by engine/window-hooks.js.
 */
const mod = (function () {
  'use strict';

  function refKey(ref) {
    if (!ref) return null;
    return String(ref.sourceId == null ? '' : ref.sourceId) + '::' + String(ref.id == null ? '' : ref.id);
  }
  function sameRef(a, b) { return refKey(a) === refKey(b); }

  // Normalize an incoming reference to the engine's feature shape. Accepts a bare id,
  // or an object with {sourceId,id,properties}. Any other fields the caller attaches
  // (geometry, a display key…) are carried through: subscribers render from the ref,
  // and dropping them left the viewer's info panel without the feature's geometry.
  function toRef(input, defaultSourceId) {
    if (input == null) return null;
    if (typeof input !== 'object') return { sourceId: defaultSourceId || null, id: input, properties: null };
    var ref = {};
    for (var k in input) if (Object.prototype.hasOwnProperty.call(input, k)) ref[k] = input[k];
    ref.sourceId = input.sourceId != null ? input.sourceId : (defaultSourceId || null);
    ref.id = input.id != null ? input.id : null;
    ref.properties = input.properties || null;
    return ref;
  }

  function createSelectionManager(opts) {
    opts = opts || {};
    var bus = opts.bus || null;
    var defaultSourceId = opts.defaultSourceId || null;
    var selected = null;
    var active = null;

    function emit(type, detail) { if (bus && bus.emit) bus.emit(type, detail); }

    function select(input) {
      var ref = toRef(input, defaultSourceId);
      if (sameRef(ref, selected)) return selected;   // no-op on re-select of the same feature
      var previous = selected;
      selected = ref;
      emit('selection-changed', { ref: selected, previous: previous });
      return selected;
    }
    function clear() {
      if (selected == null) return;
      var previous = selected;
      selected = null;
      emit('selection-changed', { ref: null, previous: previous });
    }
    function setActive(input) {
      var ref = toRef(input, defaultSourceId);
      if (sameRef(ref, active)) return active;
      var previous = active;
      active = ref;
      emit('active-feature-changed', { ref: active, previous: previous });
      return active;
    }
    function clearActive() {
      if (active == null) return;
      var previous = active;
      active = null;
      emit('active-feature-changed', { ref: null, previous: previous });
    }

    return {
      get selected() { return selected; },
      get active() { return active; },
      select: select, clear: clear, setActive: setActive, clearActive: clearActive,
    };
  }

  return { createSelectionManager: createSelectionManager, toRef: toRef, refKey: refKey };
})();

export { mod as default, mod as 'module.exports' };
