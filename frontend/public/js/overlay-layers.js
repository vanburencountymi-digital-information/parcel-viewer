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

  // opts: { format, transparent } — default image/png + transparent (regulatory
  // overlays). Full-coverage imagery (aerial) passes image/jpeg + transparent:false.
  function _buildWmsUrl(base, version, layerName, opts) {
    opts = opts || {};
    var srsParam = version === '1.3.0' ? 'CRS' : 'SRS';
    var sep = base.indexOf('?') === -1 ? '?' : '&';
    return base + sep + [
      'SERVICE=WMS',
      'VERSION=' + version,
      'REQUEST=GetMap',
      'LAYERS=' + encodeURIComponent(layerName),
      'STYLES=',
      'FORMAT=' + (opts.format || 'image/png'),
      'TRANSPARENT=' + (opts.transparent === false ? 'FALSE' : 'TRUE'),
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
      label:       'Hillshade (USGS 3DEP)',
      url:         _buildWmsUrl(_dep3Url, '1.3.0', '3DEPElevation:Hillshade Gray'),
      opacity:     0.75,
      minzoom:     0,
      beforeLayer: 'mi-aerial',        // render under the aerial image
      sideEffect:  _dimAerial,         // dim aerial while hillshade is on
      paint: {
        'raster-brightness-min': 0.0,  // keep shadows fully dark
        'raster-brightness-max': 0.40, // cap highlights at mid-gray (no more white blowout)
        'raster-contrast':       0.6,  // punch up shadow/highlight separation
        'raster-saturation':    -1.0   // full grayscale — no color cast from the WMS
      },
      attribution: _dep3Attr
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
    },
    {
      // County-hosted QGIS Server aerial (evaluation — DIC-438). Full-coverage
      // imagery, so jpeg + no transparency. Sits above the basemap/mi-aerial,
      // below parcels. NOTE: QGIS Server must send CORS headers for MapLibre to
      // render these tiles (raster tiles upload to WebGL as crossOrigin images).
      id:          'overlay-vbc-aerial-2023',
      label:       'VBC Aerial 2023 (12in) — county WMS',
      url:         _buildWmsUrl(
                     'https://wms.vanburencountymi.gov/cgi-bin/qgis_mapserv.fcgi.exe?map=VBCWMS1.qgz',
                     '1.3.0', 'AP_2023_12in', { format: 'image/jpeg', transparent: false }
                   ),
      opacity:     1.0,
      minzoom:     0,
      attribution: '<a href="https://www.vanburencountymi.gov" target="_blank" rel="noopener">Van Buren County GIS</a>'
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

  /** Lazily add the source + layer the first time an overlay is enabled. */
  function _addOverlay(cfg) {
    var map = _getMap();
    if (!map || _added[cfg.id]) return;

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
    try {
      var s = JSON.parse(localStorage.getItem(_LS_KEY) || '{}');
      OVERLAYS.forEach(function (cfg) { _state[cfg.id] = !!s[cfg.id]; });
    } catch (_) {
      OVERLAYS.forEach(function (cfg) { _state[cfg.id] = false; });
    }
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

  // ── Export ───────────────────────────────────────────────────────────────

  window.PS_OVERLAY_LAYERS = {
    setOverlay: _setOverlay,
    getState:   function () { return Object.assign({}, _state); },
    overlays:   OVERLAYS.map(function (o) {
      return { id: o.id, label: o.label, minzoom: o.minzoom };
    })
  };
}());
