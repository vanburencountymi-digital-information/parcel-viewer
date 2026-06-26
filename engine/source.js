/**
 * source.js — the source-config contract + registry (A5 / DIC-407).
 *
 * The engine knows "a source," never a domain. A source config declares everything the
 * engine needs to render and interact with a layer of features, with NO hardcoded field
 * names in engine code (§4.1):
 *
 *   {
 *     id,                                  // source id (e.g. "lots", "roads")
 *     idField,                             // the feature id field (e.g. "key", "id")
 *     search:  { fields: [...], endpoint },// omni-search config
 *     detail:  { endpoint },               // full-record endpoint ("/feature/{id}")
 *     hover:   { enabled, fields: [...] },  // hover readout fields
 *     popup:   { sections: [...] },         // see popup.js for the section shape
 *     style,                               // MapLibre style hints (opaque to the registry)
 *     legend,
 *   }
 *
 * This generalizes the existing overlay-registry pattern to the PRIMARY data + its
 * interactive behavior. The primary domain layer becomes one configured source;
 * zoning/roads/etc. are others rendered through the same engine.
 *
 * UMD: Node module (harness) + browser global (window.ISV_SOURCE).
 */
(function (root, factory) {
  'use strict';
  var mod = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
  root.ISV_SOURCE = mod;
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function isObj(v) { return v != null && typeof v === 'object' && !Array.isArray(v); }

  // Validate a source config. Returns { valid, errors }. Lenient on optional blocks —
  // only id + idField are strictly required; the rest are validated when present.
  function validate(cfg) {
    var errors = [];
    if (!isObj(cfg)) return { valid: false, errors: ['source config must be an object'] };
    if (!cfg.id || typeof cfg.id !== 'string') errors.push('source.id (string) is required');
    if (!cfg.idField || typeof cfg.idField !== 'string') errors.push('source.idField (string) is required');

    if (cfg.search != null) {
      if (!isObj(cfg.search)) errors.push('source.search must be an object');
      else if (cfg.search.fields != null && !Array.isArray(cfg.search.fields)) errors.push('source.search.fields must be an array');
    }
    if (cfg.hover != null && !isObj(cfg.hover)) errors.push('source.hover must be an object');
    if (cfg.detail != null && !isObj(cfg.detail)) errors.push('source.detail must be an object');
    if (cfg.popup != null) {
      if (!isObj(cfg.popup)) errors.push('source.popup must be an object');
      else if (cfg.popup.sections != null && !Array.isArray(cfg.popup.sections)) errors.push('source.popup.sections must be an array');
    }
    return { valid: errors.length === 0, errors: errors };
  }

  function createSourceRegistry() {
    var sources = Object.create(null);

    function define(cfg) {
      var v = validate(cfg);
      if (!v.valid) throw new Error('invalid source config: ' + v.errors.join('; '));
      sources[cfg.id] = cfg;
      return cfg;
    }
    function get(id) { return sources[id] || null; }
    function has(id) { return !!sources[id]; }
    function list() { return Object.keys(sources).map(function (k) { return sources[k]; }); }
    // Resolve a feature's id using the source's idField (never a hardcoded "pin").
    function idOf(id, feature) {
      var cfg = sources[id]; if (!cfg) return null;
      var props = (feature && feature.properties) || feature || {};
      return props[cfg.idField] != null ? props[cfg.idField] : null;
    }

    return { define: define, get: get, has: has, list: list, idOf: idOf };
  }

  return { createSourceRegistry: createSourceRegistry, validate: validate };
}));
