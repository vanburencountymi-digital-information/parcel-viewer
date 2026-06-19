/**
 * overlay-layers.js — Federal / state WMS overlay layers.
 *
 * Adds regulatory / environmental / elevation WMS sources as toggleable
 * raster overlays.  All overlays are off by default and added lazily (the
 * layer is only created in MapLibre the first time the user toggles it on).
 *
 *   Wetlands   USFWS National Wetlands Inventory      WMS 1.3.0, layer "0"
 *              (visible at zoom 12+)
 *   Flood      FEMA National Flood Hazard Layer        WMS 1.1.1, layer "12"
 *   Soils      USDA NRCS SSURGO via Soil Data Access   WMS 1.1.1, layer
 *              "MapunitPolyExtended"
 *   Hillshade  USGS 3DEP Multidirectional Hillshade    WMS 1.3.0
 *              Inserted BELOW the aerial layer; dims aerial to 65 % when on.
 *   Contours   USGS 3DEP preset contour intervals      WMS 1.3.0
 *              10 ft (zoom 13+) · 5 ft (zoom 14+) · 2 ft (zoom 15+)
 *
 * Stacking:
 *   hillshade  → inserted before 'mi-aerial' (below aerial)
 *   all others → inserted before 'parcels-fill' (above aerial, below parcels)
 *
 * Aerial side-effect: toggling hillshade on dims 'mi-aerial' raster-opacity
 * to AERIAL_DIM_OPACITY so the terrain texture bleeds through.  Toggling
 * hillshade off restores full opacity (unless the aerial is hidden).
 *
 * localStorage key: 'overlay_layers_state'  →  { id: bool, ... }
 * Exposes: window.PS_OVERLAY_LAYERS
 *          { setOverlay, getState, overlays }
 */
(function () {
  'use strict';

  var AERIAL_DIM_OPACITY  = 0.65;   // aerial opacity while hillshade is on
  var AERIAL_FULL_OPACITY = 1.0;    // aerial opacity normally

  // ── WMS URL construction ─────────────────────────────────────────────────

  function _buildWmsUrl(base, version, layerName) {
    var srsParam = version === '1.3.0' ? 'CRS' : 'SRS';
    var sep = base.indexOf('?') === -1 ? '?' : '&';
    return base + sep + [
      'SERVICE=WMS',
      'VERSION=' + version,
      'REQUEST=GetMap',
      'LAYERS=' + encodeURIComponent(layerName),
      'STYLES=',
      'FORMAT=image/png',
      'TRANSPARENT=TRUE',
      srsParam + '=EPSG:3857',
      'WIDTH=256',
      'HEIGHT=256',
      'BBOX={bbox-epsg-3857}'
    ].join('&');
  }

  // ── Aerial side-effect helpers ───────────────────────────────────────────

  function _dimAerial(map, on) {
    if (!map || !map.getLayer('mi-aerial')) return;
    map.setPaintProperty('mi-aerial', 'raster-opacity',
      on ? AERIAL_DIM_OPACITY : AERIAL_FULL_OPACITY);
  }

  // ── Overlay registry ─────────────────────────────────────────────────────

  var _dep3Url = 'https://elevation.nationalmap.gov/arcgis/services/3DEPElevation/ImageServer/WMSServer';
  var _dep3Attr = '<a href="https://www.usgs.gov/3d-elevation-program" target="_blank" rel="noopener">USGS 3D Elevation Program</a>';

  var OVERLAYS = [
    {
      id:          'overlay-wetlands',
      label:       'Wetlands (USFWS NWI)',
      url:         _buildWmsUrl(
                     'https://fwspublicservices.wim.usgs.gov/wetlandsmapservice/services/Wetlands/MapServer/WMSServer',
                     '1.3.0', '0'
                   ),
      opacity:     0.6,
      minzoom:     12,
      attribution: '<a href="https://www.fws.gov/program/national-wetlands-inventory" target="_blank" rel="noopener">USFWS National Wetlands Inventory</a>'
    },
    {
      id:          'overlay-flood',
      label:       'Flood Hazard (FEMA NFHL)',
      url:         _buildWmsUrl(
                     'https://hazards.fema.gov/arcgis/services/public/NFHLWMS/MapServer/WMSServer',
                     '1.1.1', '12'
                   ),
      opacity:     0.5,
      minzoom:     0,
      attribution: '<a href="https://www.fema.gov/flood-maps/national-flood-hazard-layer" target="_blank" rel="noopener">FEMA National Flood Hazard Layer</a>'
    },
    {
      id:          'overlay-soils',
      label:       'Soils (USDA SSURGO)',
      url:         _buildWmsUrl(
                     'https://sdmdataaccess.nrcs.usda.gov/Spatial/SDM.wms',
                     '1.1.1', 'MapunitPolyExtended'
                   ),
      opacity:     0.55,
      minzoom:     0,
      attribution: '<a href="https://www.nrcs.usda.gov/resources/data-and-reports/soil-survey-geographic-database-ssurgo" target="_blank" rel="noopener">USDA NRCS SSURGO</a>'
    },
    {
      id:          'overlay-hillshade',
      label:       'Hillshade',
      // Client-side hillshade (DIC-507): MapLibre computes relief on the GPU from
      // a DEM tile source — fast static CDN tiles instead of the slow per-tile
      // 3DEP WMS GetMap render. SOURCE IS ISOLATED for the in-house swap: point
      // `demTiles` at our own Martin terrain-RGB endpoint later and nothing else
      // changes (treatment/blend below is source-agnostic).
      kind:        'hillshade-dem',
      demTiles:    ['https://elevation-tiles-prod.s3.amazonaws.com/terrarium/{z}/{x}/{y}.png'],
      demEncoding: 'terrarium',
      demMaxzoom:  15,                 // AWS Terrain Tiles depth (US NED ~10 m); overzoom past
      minzoom:     0,
      beforeLayer: 'mi-aerial',        // bottom of the stack — under parcels + aerial
      sideEffect:  _dimAerial,         // dim aerial so relief shows through when both on
      // Theme-aware treatment, dialled PUNCHY (DIC-507): max exaggeration + strong
      // shadow/highlight separation so the gentle moraine relief reads as a
      // featured cartographic element. Warm shadows tie to the terracotta ground;
      // dark theme drives bright warm highlights so ridges pop on the dim basemap.
      // Still under parcels + class wash, which stay legible on top.
      paintByTheme: {
        light: {
          'hillshade-exaggeration':           0.9,
          'hillshade-shadow-color':           '#2e2014',   // deep warm shadow (high contrast)
          'hillshade-highlight-color':        '#fff6e2',   // warm light, not pure white
          'hillshade-accent-color':           '#7a5a36',   // crisp slope edges
          'hillshade-illumination-direction': 315,
        },
        dark: {
          'hillshade-exaggeration':           1.0,
          'hillshade-shadow-color':           '#000000',
          'hillshade-highlight-color':        '#d8bd92',   // bright warm so ridges pop on dark
          'hillshade-accent-color':           '#6b4f30',
          'hillshade-illumination-direction': 315,
        },
      },
      attribution: 'Elevation: <a href="https://registry.opendata.aws/terrain-tiles/" target="_blank" rel="noopener">AWS Terrain Tiles</a> / USGS 3DEP',
    },
    {
      id:          'overlay-contours-10ft',
      label:       'Contours 10ft (USGS 3DEP)',
      url:         _buildWmsUrl(_dep3Url, '1.3.0', '3DEPElevation:Preset 10ft Contour Interval'),
      opacity:     0.8,
      minzoom:     13,
      attribution: _dep3Attr
    },
    {
      id:          'overlay-contours-5ft',
      label:       'Contours 5ft (USGS 3DEP)',
      url:         _buildWmsUrl(_dep3Url, '1.3.0', '3DEPElevation:Preset 5ft Contour Interval'),
      opacity:     0.8,
      minzoom:     14,
      attribution: _dep3Attr
    },
    {
      id:          'overlay-contours-2ft',
      label:       'Contours 2ft (USGS 3DEP)',
      url:         _buildWmsUrl(_dep3Url, '1.3.0', '3DEPElevation:Preset 2ft Contour Interval'),
      opacity:     0.8,
      minzoom:     15,
      attribution: _dep3Attr
    }
  ];

  // ── State ────────────────────────────────────────────────────────────────

  var _LS_KEY = 'overlay_layers_state';
  var _state  = {};    // { id: true/false } — what user wants
  var _added  = {};    // { id: true/false } — what's on the map

  function _findById(id) {
    for (var i = 0; i < OVERLAYS.length; i++) {
      if (OVERLAYS[i].id === id) return OVERLAYS[i];
    }
    return null;
  }

  // ── Map integration ──────────────────────────────────────────────────────

  function _getMap() { return window.PS_MAP || null; }

  function _isDark() { return document.documentElement.getAttribute('data-theme') === 'dark'; }

  // Theme-appropriate hillshade-* paint for a DEM overlay.
  function _hillshadePaint(cfg) {
    var p = cfg.paintByTheme || {};
    return (_isDark() ? p.dark : p.light) || p.light || {};
  }

  // Re-apply hillshade paint when the viewer switches light/dark.
  function _retintHillshade() {
    var map = _getMap();
    if (!map) return;
    OVERLAYS.forEach(function (cfg) {
      if (cfg.kind === 'hillshade-dem' && _added[cfg.id] && map.getLayer(cfg.id)) {
        var paint = _hillshadePaint(cfg);
        Object.keys(paint).forEach(function (k) { map.setPaintProperty(cfg.id, k, paint[k]); });
      }
    });
  }

  /** Lazily add the source + layer the first time an overlay is enabled. */
  function _addOverlay(cfg) {
    var map = _getMap();
    if (!map || _added[cfg.id]) return;

    // Client-side hillshade from a DEM source (DIC-507) — raster-dem + a hillshade
    // layer (GPU-rendered relief), inserted at the bottom of the stack.
    if (cfg.kind === 'hillshade-dem') {
      if (!map.getSource(cfg.id)) {
        map.addSource(cfg.id, {
          type:        'raster-dem',
          tiles:       cfg.demTiles,
          encoding:    cfg.demEncoding || 'terrarium',
          tileSize:    256,
          maxzoom:     cfg.demMaxzoom || 14,
          attribution: cfg.attribution,
        });
      }
      var hbefore = cfg.beforeLayer && map.getLayer(cfg.beforeLayer) ? cfg.beforeLayer
        : (map.getLayer('parcels-fill') ? 'parcels-fill' : undefined);
      if (!map.getLayer(cfg.id)) {
        map.addLayer({
          id:      cfg.id,
          type:    'hillshade',
          source:  cfg.id,
          minzoom: cfg.minzoom || 0,
          paint:   _hillshadePaint(cfg),
          layout:  { visibility: _state[cfg.id] ? 'visible' : 'none' },
        }, hbefore);
      }
      _added[cfg.id] = true;
      return;
    }

    if (!map.getSource(cfg.id)) {
      map.addSource(cfg.id, {
        type:        'raster',
        tiles:       [cfg.url],
        tileSize:    256,
        attribution: cfg.attribution
      });
    }

    // Use per-overlay beforeLayer if specified, otherwise sit below parcels.
    var before = cfg.beforeLayer && map.getLayer(cfg.beforeLayer)
      ? cfg.beforeLayer
      : (map.getLayer('parcels-fill') ? 'parcels-fill' : undefined);

    if (!map.getLayer(cfg.id)) {
      var paint = Object.assign({ 'raster-opacity': cfg.opacity }, cfg.paint || {});
      map.addLayer({
        id:      cfg.id,
        type:    'raster',
        source:  cfg.id,
        minzoom: cfg.minzoom || 0,
        paint:   paint,
        layout:  { visibility: _state[cfg.id] ? 'visible' : 'none' }
      }, before);
    }

    _added[cfg.id] = true;
  }

  function _setOverlay(id, on) {
    _state[id] = !!on;
    _saveState();

    // Sync the checkbox in the Layers panel so the UI stays consistent
    // whether the toggle was triggered by the user or by the AI.
    var cb = document.getElementById(id + '-toggle');
    if (cb) cb.checked = !!on;

    var map = _getMap();
    if (!map) return;    // _waitForMap will pick this up later

    var cfg = _findById(id);
    if (!cfg) return;

    if (on) {
      _addOverlay(cfg);
      if (_added[id]) map.setLayoutProperty(id, 'visibility', 'visible');
    } else if (_added[id]) {
      map.setLayoutProperty(id, 'visibility', 'none');
    }

    // Run any side-effect (e.g. hillshade dims the aerial)
    if (cfg.sideEffect) cfg.sideEffect(map, !!on);
  }

  // ── Persistence ──────────────────────────────────────────────────────────

  function _saveState() {
    try { localStorage.setItem(_LS_KEY, JSON.stringify(_state)); } catch (_) {}
  }

  function _loadState() {
    var s = {};
    try { s = JSON.parse(localStorage.getItem(_LS_KEY) || '{}'); } catch (_) { s = {}; }
    // Config-driven defaults (DIC-507): hillshade ships OFF by default but flipping
    // it ON is a one-line config change (COUNTY.styling.hillshade.defaultOn) — no
    // code edit — for when the in-house DEM tiles land. A stored user pref wins.
    var defaults = {};
    try {
      if (window.COUNTY && COUNTY.styling && COUNTY.styling.hillshade) {
        defaults['overlay-hillshade'] = !!COUNTY.styling.hillshade.defaultOn;
      }
    } catch (_) {}
    OVERLAYS.forEach(function (cfg) {
      _state[cfg.id] = (cfg.id in s) ? !!s[cfg.id] : !!defaults[cfg.id];
    });
  }

  // ── UI wiring ────────────────────────────────────────────────────────────

  function _wireUI() {
    OVERLAYS.forEach(function (cfg) {
      var cb = document.getElementById(cfg.id + '-toggle');
      if (!cb) return;
      cb.checked = !!_state[cfg.id];
      cb.addEventListener('change', function () {
        _setOverlay(cfg.id, this.checked);
      });
    });
  }

  // ── Init ─────────────────────────────────────────────────────────────────

  /** Poll for the map; when it's ready add any overlays the user had on. */
  function _waitForMap() {
    if (!_getMap()) { setTimeout(_waitForMap, 300); return; }
    OVERLAYS.forEach(function (cfg) {
      if (_state[cfg.id]) {
        _addOverlay(cfg);
        // Restore side-effects persisted from a previous session
        if (cfg.sideEffect) cfg.sideEffect(_getMap(), true);
      }
    });
  }

  _loadState();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _wireUI);
  } else {
    _wireUI();
  }
  _waitForMap();
  // Re-tint the hillshade on light/dark switch (DIC-507).
  try {
    new MutationObserver(_retintHillshade).observe(document.documentElement,
      { attributes: true, attributeFilter: ['data-theme'] });
  } catch (_) {}

  // ── Export ───────────────────────────────────────────────────────────────

  window.PS_OVERLAY_LAYERS = {
    setOverlay: _setOverlay,
    getState:   function () { return Object.assign({}, _state); },
    overlays:   OVERLAYS.map(function (o) {
      return { id: o.id, label: o.label, minzoom: o.minzoom };
    })
  };
}());
