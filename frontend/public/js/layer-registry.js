/**
 * layer-registry.js — live map-layer registry (DIC-327).
 *
 * Maintains window.PS_LAYER_REGISTRY: a snapshot of every layer the viewer knows
 * about — parcels, the aerial basemap, regulatory WMS overlays, and the county
 * PostGIS vector layers — each with its CURRENT visibility and field schema.
 * Map Buddy reads this so its answers reflect what's actually on the map right
 * now, instead of a frozen deploy-time view ("what am I looking at?", "are there
 * wetlands on this parcel?").
 *
 * Sources of truth (read live, never duplicated):
 *   parcels      COUNTY.styling.layers.parcels.choropleth.fields + #toggle-zoning
 *   aerial       #toggle-aerial
 *   WMS overlays PS_OVERLAY_LAYERS (.overlays + .getState)
 *   PostGIS      COUNTY.layers.overlays (type:'vector') + PS_PG_LAYERS.getState
 *
 * Fires `ps:layers-changed` whenever a layer toggle changes so subscribers can
 * react. Consumers that need fresh state on demand call `.snapshot()`.
 *
 * Exposes: window.PS_LAYER_REGISTRY { layers, refresh(), snapshot(), summary() }
 */
(function () {
  'use strict';

  var _layers = {};   // id -> { id, label, type, visible, fields, geomType? }

  function _county()  { return window.COUNTY || {}; }
  function _checked(id) { var el = document.getElementById(id); return !!(el && el.checked); }

  // Parcel tile attributes (drives "what fields does this layer have").
  function _parcelFields() {
    try {
      var p  = _county().styling && _county().styling.layers && _county().styling.layers.parcels;
      var ch = p && p.choropleth;
      if (ch && ch.fields) return ch.fields.slice();
    } catch (_) {}
    return [];
  }

  function _vectorOverlays() {
    var L = _county().layers || {};
    return (L.overlays || []).filter(function (o) {
      return o && String(o.type || '').toLowerCase() === 'vector';
    });
  }

  // Recompute the registry from live state, replacing the exported object's
  // contents in place so existing references to window.PS_LAYER_REGISTRY.layers
  // stay valid.
  function rebuild() {
    var next = {};

    next['parcels']   = { id: 'parcels',   label: 'Parcels',        type: 'vector', visible: _checked('toggle-zoning'), fields: _parcelFields() };
    next['mi-aerial'] = { id: 'mi-aerial', label: 'Aerial imagery', type: 'raster', visible: _checked('toggle-aerial'), fields: [] };

    // Regulatory WMS overlays (wetlands / flood / soils / hillshade / contours).
    try {
      var wms = window.PS_OVERLAY_LAYERS;
      if (wms && wms.overlays) {
        var st = (wms.getState && wms.getState()) || {};
        wms.overlays.forEach(function (o) {
          next[o.id] = { id: o.id, label: o.label || o.id, type: 'wms', visible: !!st[o.id], fields: [] };
        });
      }
    } catch (_) {}

    // County PostGIS vector overlays (config-as-data; fields from discovery).
    try {
      var pg  = window.PS_PG_LAYERS;
      var pst = (pg && pg.getState && pg.getState()) || {};
      _vectorOverlays().forEach(function (o) {
        next[o.id] = {
          id: o.id, label: o.label || o.id, type: 'vector',
          visible: !!pst[o.id], fields: (o.fields || []).slice(), geomType: o.geomType,
        };
      });
    } catch (_) {}

    Object.keys(_layers).forEach(function (k) { delete _layers[k]; });
    Object.keys(next).forEach(function (k) { _layers[k] = next[k]; });
    return _layers;
  }

  // Structured snapshot (array) for the chat payload — always fresh.
  function snapshot() {
    rebuild();
    return Object.keys(_layers).map(function (k) {
      var l = _layers[k];
      return { id: l.id, label: l.label, type: l.type, visible: l.visible, fields: l.fields };
    });
  }

  // One-line-per-layer text summary (debugging / human-readable).
  function summary() {
    rebuild();
    return Object.keys(_layers).map(function (k) {
      var l = _layers[k];
      var f = (l.fields && l.fields.length) ? ' [' + l.fields.join(', ') + ']' : '';
      return '- ' + l.label + ' (' + l.type + ', ' + (l.visible ? 'visible' : 'hidden') + ')' + f;
    }).join('\n');
  }

  function _fire() { try { document.dispatchEvent(new CustomEvent('ps:layers-changed')); } catch (_) {} }

  // Re-snapshot + announce whenever a layer toggle changes. Covers user clicks;
  // programmatic toggles (Map Buddy via PS_OVERLAY_LAYERS / PS_PG_LAYERS) are
  // also reflected because the chat payload re-reads fresh state per request.
  function _wire() {
    document.addEventListener('change', function (e) {
      var t = e.target;
      if (!t || t.type !== 'checkbox') return;
      var id = t.id || '';
      if (id === 'toggle-aerial' || id === 'toggle-zoning' ||
          /^overlay-.*-toggle$/.test(id) || /^pg-.*-toggle$/.test(id)) {
        rebuild();
        _fire();
      }
    });
  }

  rebuild();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { rebuild(); _wire(); });
  } else {
    _wire();
  }

  window.PS_LAYER_REGISTRY = { layers: _layers, refresh: rebuild, snapshot: snapshot, summary: summary };
}());
