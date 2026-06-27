/**
 * county-layers.js — County PostGIS vector overlays via Martin MVT.
 *
 * Reads layer definitions from COUNTY.layers.countyOverlays (see county-config.js).
 * Layers are off by default and added lazily on first toggle, matching the WMS
 * overlay pattern in overlay-layers.js.
 *
 * Exposes: window.PS_COUNTY_LAYERS
 *          { setLayer, getState, layers }
 */
(function () {
  'use strict';

  var _LS_KEY = 'county_layers_state';
  var _state  = {};
  var _added  = {};

  function _county() {
    return (window.PS_CONTEXT && window.PS_CONTEXT.config) || window.COUNTY || {};
  }

  function _martinBase() {
    var url = (window.PS_CONFIG && window.PS_CONFIG.MARTIN_URL) || '/tiles';
    if (/^https?:\/\//.test(url)) return url;
    return window.location.origin + url;
  }

  // Phase 3 (DIC-407): prefer the manifest's county-overlay sources (role 'county-overlay',
  // carrying martin/geom/minzoom/sourceLayer/paint verbatim), falling back to
  // COUNTY.layers.countyOverlays. Identical entry shape → the layer-building code below is
  // unchanged.
  function _registry() {
    var fromManifest = window.PV_MANIFEST && window.PV_MANIFEST.sourcesByRole && window.PV_MANIFEST.sourcesByRole('county-overlay');
    if (fromManifest && fromManifest.length) return fromManifest;
    var layers = _county().layers || {};
    var cfg = layers.countyOverlays;
    return Array.isArray(cfg) ? cfg : [];
  }

  function _findById(id) {
    var list = _registry();
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === id) return list[i];
    }
    return null;
  }

  function _getMap() { return window.PS_MAP || null; }

  function _beforeLayer(map, cfg) {
    if (cfg.beforeLayer && map.getLayer(cfg.beforeLayer)) return cfg.beforeLayer;
    if (cfg.geom === 'point' && map.getLayer('parcels-fill')) return 'parcels-fill';
    return map.getLayer('parcels-fill') ? 'parcels-fill' : undefined;
  }

  function _addMapLayers(cfg) {
    var map = _getMap();
    if (!map || _added[cfg.id]) return;

    var sourceId = cfg.id + '-src';
    var tileUrl  = _martinBase() + '/' + cfg.martin + '/{z}/{x}/{y}';

    if (!map.getSource(sourceId)) {
      map.addSource(sourceId, {
        type:         'vector',
        tiles:        [tileUrl],
        minzoom:      cfg.minzoom || 0,
        maxzoom:      22
      });
    }

    var before = _beforeLayer(map, cfg);
    var vis    = _state[cfg.id] ? 'visible' : 'none';
    var sl     = cfg.sourceLayer;

    if (cfg.geom === 'polygon') {
      var fillId = cfg.id + '-fill';
      var lineId = cfg.id + '-line';
      if (!map.getLayer(fillId)) {
        map.addLayer({
          id:           fillId,
          type:         'fill',
          source:       sourceId,
          'source-layer': sl,
          minzoom:      cfg.minzoom || 0,
          layout:       { visibility: vis },
          paint:        Object.assign({
            'fill-opacity': 0.25
          }, (cfg.paint && cfg.paint.fill) || {})
        }, before);
      }
      if (!map.getLayer(lineId)) {
        map.addLayer({
          id:           lineId,
          type:         'line',
          source:       sourceId,
          'source-layer': sl,
          minzoom:      cfg.minzoom || 0,
          layout:       { visibility: vis },
          paint:        Object.assign({
            'line-width': 1.2,
            'line-opacity': 0.85
          }, (cfg.paint && cfg.paint.line) || {})
        }, before);
      }
    } else if (cfg.geom === 'line') {
      var lnId = cfg.id + '-line';
      if (!map.getLayer(lnId)) {
        map.addLayer({
          id:           lnId,
          type:         'line',
          source:       sourceId,
          'source-layer': sl,
          minzoom:      cfg.minzoom || 0,
          layout:       { visibility: vis },
          paint:        Object.assign({
            'line-width': 1.5,
            'line-opacity': 0.9
          }, (cfg.paint && cfg.paint.line) || {})
        }, before);
      }
    } else if (cfg.geom === 'point') {
      var ptId = cfg.id + '-circle';
      if (!map.getLayer(ptId)) {
        map.addLayer({
          id:           ptId,
          type:         'circle',
          source:       sourceId,
          'source-layer': sl,
          minzoom:      cfg.minzoom || 0,
          layout:       { visibility: vis },
          paint:        Object.assign({
            'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 2, 14, 4, 17, 6],
            'circle-opacity': 0.85,
            'circle-stroke-width': 1,
            'circle-stroke-color': '#ffffff',
            'circle-stroke-opacity': 0.8
          }, (cfg.paint && cfg.paint.circle) || {})
        }, before);
      }
    }

    _added[cfg.id] = true;
  }

  function _layerIds(cfg) {
    if (cfg.geom === 'polygon') return [cfg.id + '-fill', cfg.id + '-line'];
    if (cfg.geom === 'line') return [cfg.id + '-line'];
    return [cfg.id + '-circle'];
  }

  function _setLayer(id, on) {
    _state[id] = !!on;
    _saveState();

    var cb = document.getElementById(id + '-toggle');
    if (cb) cb.checked = !!on;

    var map = _getMap();
    if (!map) return;

    var cfg = _findById(id);
    if (!cfg) return;

    if (on) {
      _addMapLayers(cfg);
    }

    if (!_added[id]) return;

    var vis = on ? 'visible' : 'none';
    _layerIds(cfg).forEach(function (lid) {
      if (map.getLayer(lid)) map.setLayoutProperty(lid, 'visibility', vis);
    });
  }

  function _saveState() {
    try { localStorage.setItem(_LS_KEY, JSON.stringify(_state)); } catch (_) {}
  }

  function _loadState() {
    var list = _registry();
    try {
      var s = JSON.parse(localStorage.getItem(_LS_KEY) || '{}');
      list.forEach(function (cfg) { _state[cfg.id] = !!s[cfg.id]; });
    } catch (_) {
      list.forEach(function (cfg) { _state[cfg.id] = false; });
    }
  }

  function _wireUI() {
    _registry().forEach(function (cfg) {
      var cb = document.getElementById(cfg.id + '-toggle');
      if (!cb) return;
      cb.checked = !!_state[cfg.id];
      cb.addEventListener('change', function () {
        _setLayer(cfg.id, this.checked);
      });
    });
  }

  function _waitForMap() {
    if (!_getMap()) { setTimeout(_waitForMap, 300); return; }
    _registry().forEach(function (cfg) {
      if (_state[cfg.id]) _addMapLayers(cfg);
    });
  }

  _loadState();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _wireUI);
  } else {
    _wireUI();
  }
  _waitForMap();

  window.PS_COUNTY_LAYERS = {
    setLayer: _setLayer,
    getState: function () { return Object.assign({}, _state); },
    layers:   function () {
      return _registry().map(function (o) {
        return { id: o.id, label: o.label, minzoom: o.minzoom };
      });
    }
  };
}());
