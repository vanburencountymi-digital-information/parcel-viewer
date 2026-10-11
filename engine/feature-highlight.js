/**
 * feature-highlight.js — source-agnostic MapLibre feature-state highlighter
 * (A4 / DIC-569, slice 2).
 *
 * Lifts the "set a feature-state slot to drive a highlight layer" mechanism out of
 * the map runtime into a small, configurable, testable helper. It knows a SOURCE
 * (id + sourceLayer), never a domain (§4.1) — one helper highlights any configured
 * source. The selection state machine (selection.js) decides WHAT is
 * selected; this decides HOW it lights up; the bus connects them.
 *
 * createFeatureHighlighter({ map, sourceId, sourceLayer }) -> { set, bindActive }
 *   map: a MapLibre map, or a function returning one (lazy — the map is created late).
 *   set(id, state):   map.setFeatureState({source, sourceLayer, id}, state)  (no-op if no map/id)
 *   bindActive(bus, { stateKey }): subscribe to 'active-feature-changed' and toggle a
 *     single-active slot (clear the previous feature, set the new) — event-driven,
 *     so chrome/selection drive rendering by emitting, not by calling the map.
 *
 * ES module (DIC-2180): imported by the harness and, in the browser, put on
 * window.ISV_HIGHLIGHT by engine/window-hooks.js.
 */
const mod = (function () {
  'use strict';

  function createFeatureHighlighter(opts) {
    opts = opts || {};
    var sourceId = opts.sourceId;
    var sourceLayer = opts.sourceLayer;
    function getMap() { return typeof opts.map === 'function' ? opts.map() : opts.map; }

    function set(id, state) {
      var map = getMap();
      if (!map || id == null || typeof map.setFeatureState !== 'function') return;
      try {
        map.setFeatureState({ source: sourceId, sourceLayer: sourceLayer, id: id }, state);
      } catch (e) { /* source not loaded yet / unknown id — harmless */ }
    }

    // Event-driven single-active highlight: only one feature carries `stateKey:true`
    // at a time. Clears the previous active feature, sets the new one.
    function bindActive(bus, cfg) {
      cfg = cfg || {};
      var stateKey = cfg.stateKey || 'active';
      var current = null;
      if (!bus || !bus.on) return function () {};
      return bus.on('active-feature-changed', function (detail) {
        var ref = detail && detail.ref;
        var nextId = ref ? ref.id : null;
        if (current != null) { var off = {}; off[stateKey] = false; set(current, off); }
        if (nextId != null) { var on = {}; on[stateKey] = true; set(nextId, on); }
        current = nextId;
      });
    }

    return { set: set, bindActive: bindActive };
  }

  return { createFeatureHighlighter: createFeatureHighlighter };
})();

export { mod as default, mod as 'module.exports' };
