/**
 * validate-manifest.js — minimal, zero-dependency manifest validator (A2 stub).
 *
 * Enforces the structural rules CI needs TODAY so an invalid manifest cannot publish
 * (§5.2): required top-level keys, at least one well-formed source, and the
 * capability AI tri-state enum (§4.7). It deliberately checks a subset of
 * schema/manifest.schema.json.
 *
 * PROVISIONAL (C2 / DIC-583): this is a stand-in for full JSON-Schema validation.
 * When C2 adds a schema validator dependency (e.g. Ajv), point it at
 * schema/manifest.schema.json and retire this. Kept dependency-free so the harness
 * runs with stock Node and the no-build-tool frontend ethos holds.
 *
 * validate(manifest) -> { valid: boolean, errors: string[] }
 *
 * UMD: Node module (harness) + browser global (window.ISV_VALIDATE_MANIFEST).
 */
(function (root, factory) {
  'use strict';
  var mod = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
  root.ISV_VALIDATE_MANIFEST = mod;
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var AI_TRISTATE = ['no-ai', 'ai-optional', 'ai-required'];
  var SOURCE_TYPES = ['vector', 'raster', 'wms', 'geojson'];

  function validate(m) {
    var errors = [];
    function isObj(v) { return v != null && typeof v === 'object' && !Array.isArray(v); }

    if (!isObj(m)) return { valid: false, errors: ['manifest must be an object'] };

    ['manifestVersion', 'id', 'tenant', 'map', 'sources', 'capabilities'].forEach(function (k) {
      if (!(k in m) || m[k] == null || m[k] === '') errors.push('missing required key: ' + k);
    });

    if (m.manifestVersion != null && !/^[0-9]+\.[0-9]+$/.test(String(m.manifestVersion))) {
      errors.push('manifestVersion must look like "1.0"');
    }

    if (m.map != null) {
      if (!isObj(m.map)) errors.push('map must be an object');
      else {
        if (!Array.isArray(m.map.center) || m.map.center.length !== 2) errors.push('map.center must be [lng, lat]');
        if (typeof m.map.zoom !== 'number') errors.push('map.zoom must be a number');
      }
    }

    if (m.sources != null) {
      if (!Array.isArray(m.sources) || m.sources.length < 1) {
        errors.push('sources must be a non-empty array');
      } else {
        m.sources.forEach(function (s, i) {
          if (!isObj(s)) { errors.push('sources[' + i + '] must be an object'); return; }
          if (!s.id) errors.push('sources[' + i + '] missing id');
          if (!s.type) errors.push('sources[' + i + '] missing type');
          else if (SOURCE_TYPES.indexOf(s.type) < 0) errors.push('sources[' + i + '] invalid type: ' + s.type);
        });
      }
    }

    if (m.capabilities != null) {
      if (!isObj(m.capabilities)) errors.push('capabilities must be an object');
      else {
        Object.keys(m.capabilities).forEach(function (capId) {
          var cfg = m.capabilities[capId];
          if (!isObj(cfg)) { errors.push('capabilities.' + capId + ' must be an object'); return; }
          if (cfg.ai != null && AI_TRISTATE.indexOf(cfg.ai) < 0) {
            errors.push('capabilities.' + capId + '.ai must be one of ' + AI_TRISTATE.join('/') + ' (got "' + cfg.ai + '")');
          }
        });
      }
    }

    return { valid: errors.length === 0, errors: errors };
  }

  return { validate: validate, AI_TRISTATE: AI_TRISTATE.slice(), SOURCE_TYPES: SOURCE_TYPES.slice() };
}));
