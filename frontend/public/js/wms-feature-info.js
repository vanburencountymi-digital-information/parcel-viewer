/**
 * wms-feature-info.js — Overlay feature info click popup.
 *
 * Listens for map clicks.  When at least one queryable overlay is visible
 * it fires parallel queries to each visible service and displays the results
 * in a MapLibre popup anchored to the click point.
 *
 * Query strategy per service:
 *   Flood    FEMA NFHL       ArcGIS REST point query  (JSON natively)
 *   Wetlands USFWS NWI       ArcGIS REST point query  (JSON natively)
 *   Soils    USDA SSURGO     WMS GetFeatureInfo        (text/xml → DOMParser)
 *
 * All requests are routed through /wms-proxy to avoid CORS restrictions.
 *
 * Exposes: window.PS_WMS_FEATURE_INFO  { getPopup }
 */
(function () {
  'use strict';

  // ── Layer registry ───────────────────────────────────────────────────────
  //
  // restUrl  → use ArcGIS REST identify (returns JSON, outFields from attrs)
  // base     → use WMS GetFeatureInfo   (returns text/xml, parsed via DOMParser)

  var QUERYABLE = [
    {
      overlayId: 'overlay-flood',
      label:     'Flood Hazard Zone',
      color:     '#3b82f6',
      restUrl:   'https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28/query',
      attrs: [
        { key: 'FLD_ZONE',   label: 'Flood Zone'       },
        { key: 'ZONE_SUBTY', label: 'Zone Subtype'     },
        { key: 'SFHA_TF',    label: 'SFHA'             },
        { key: 'STATIC_BFE', label: 'Base Flood Elev.' }
      ]
    },
    {
      overlayId: 'overlay-wetlands',
      label:     'Wetland Classification',
      color:     '#16a34a',
      restUrl:   'https://fwspublicservices.wim.usgs.gov/wetlandsmapservice/rest/services/Wetlands/MapServer/0/query',
      attrs: [
        { key: 'WETLAND_TYPE', label: 'Wetland Type' },
        { key: 'ATTRIBUTE',    label: 'Attribute'    },
        { key: 'ACRES',        label: 'Acres'        }
      ]
    },
    {
      overlayId: 'overlay-soils',
      label:     'Soil Map Unit',
      color:     '#92400e',
      base:      'https://sdmdataaccess.nrcs.usda.gov/Spatial/SDM.wms',
      version:   '1.1.1',
      layerId:   'MapunitPolyExtended',
      attrs: [
        { key: 'MUSYM',  label: 'Soil Symbol'  },
        { key: 'MUNAME', label: 'Soil Name'    },
        { key: 'MUKEY',  label: 'Map Unit Key' }
      ]
    }
  ];

  var _popup = null;

  // ── Coordinate helpers ───────────────────────────────────────────────────

  function _toMercator(lng, lat) {
    var R    = 6378137;
    var x    = lng * Math.PI * R / 180;
    var latR = lat * Math.PI / 180;
    var y    = Math.log(Math.tan(Math.PI / 4 + latR / 2)) * R;
    return [x, y];
  }

  // ── ArcGIS REST point query ──────────────────────────────────────────────

  function _fetchRest(cfg, map, point) {
    var lngLat = map.unproject(point);
    // Use outFields=* — some services (e.g. USFWS NWI) prefix field names with
    // the table name (e.g. "Wetlands.WETLAND_TYPE"), so requesting specific
    // short names returns a 400 error.  We normalise the keys after receipt.
    var restUrl = cfg.restUrl +
      '?geometry='        + lngLat.lng + '%2C' + lngLat.lat +
      '&geometryType=esriGeometryPoint' +
      '&inSR=4326' +
      '&spatialRel=esriSpatialRelIntersects' +
      '&outFields=*' +
      '&returnGeometry=false' +
      '&f=json';

    return fetch((window.API_BASE || '') + '/wms-proxy?url=' + encodeURIComponent(restUrl))
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (data) {
        if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
        var features = (data.features || []).map(function (f) {
          var raw = f.attributes || {};
          // Strip any "TableName." prefix so "Wetlands.WETLAND_TYPE" → "WETLAND_TYPE"
          var props = {};
          Object.keys(raw).forEach(function (k) {
            var short = k.indexOf('.') !== -1 ? k.split('.').pop() : k;
            props[short] = raw[k];
          });
          return { type: 'Feature', properties: props };
        });
        return { cfg: cfg, features: features };
      })
      .catch(function (err) {
        return { cfg: cfg, features: [], error: err.message };
      });
  }

  // ── WMS GetFeatureInfo (text/xml) ────────────────────────────────────────

  function _buildWmsUrl(cfg, map, point) {
    var canvas = map.getCanvas();
    var W = canvas.clientWidth;
    var H = canvas.clientHeight;

    var bounds = map.getBounds();
    var sw   = _toMercator(bounds.getWest(),  bounds.getSouth());
    var ne   = _toMercator(bounds.getEast(),  bounds.getNorth());
    var bbox = sw[0] + ',' + sw[1] + ',' + ne[0] + ',' + ne[1];

    var px = Math.round(point.x);
    var py = Math.round(point.y);
    // WMS 1.3.0 uses I/J and CRS=; WMS 1.1.1 uses X/Y and SRS=
    var is130    = cfg.version === '1.3.0';
    var crsParam = is130 ? 'CRS' : 'SRS';
    var xParam   = is130 ? 'I'   : 'X';
    var yParam   = is130 ? 'J'   : 'Y';

    return cfg.base +
      '?SERVICE=WMS&VERSION=' + cfg.version +
      '&REQUEST=GetFeatureInfo' +
      '&LAYERS='       + encodeURIComponent(cfg.layerId) +
      '&QUERY_LAYERS=' + encodeURIComponent(cfg.layerId) +
      '&BBOX='         + bbox +
      '&WIDTH='        + W + '&HEIGHT=' + H +
      '&' + xParam + '=' + px + '&' + yParam + '=' + py +
      '&' + crsParam + '=EPSG:3857' +
      '&INFO_FORMAT=text/plain' +
      '&FEATURE_COUNT=5';
  }

  /**
   * Parse a WMS GetFeatureInfo text/plain response (SSURGO format) into features.
   *
   * SSURGO returns blocks like:
   *   Layer 'mapunitpolyextended'
   *     Feature 123:
   *       musym = '21A'
   *       muname = 'Bronson sandy loam, 0 to 3 percent slopes'
   *       mukey = '186966'
   *       ...
   */
  function _parseSoilsText(text) {
    try {
      var features = [];
      // Split on "Feature NNN:" blocks
      var blocks = text.split(/Feature\s+\d+\s*:/i);
      // blocks[0] is the header line, blocks[1+] are feature data
      for (var i = 1; i < blocks.length; i++) {
        var props = {};
        var lines = blocks[i].split('\n');
        lines.forEach(function (line) {
          // Match:  key = 'value'  or  key = value
          var m = line.match(/^\s*([\w]+)\s*=\s*'?([^']*)'?\s*$/);
          if (m && m[2].trim() !== '') {
            props[m[1].toUpperCase()] = m[2].trim();
          }
        });
        if (Object.keys(props).length > 0) {
          features.push({ type: 'Feature', properties: props });
        }
      }
      return features;
    } catch (_) {
      return [];
    }
  }

  function _fetchWms(cfg, map, point) {
    var wmsUrl = _buildWmsUrl(cfg, map, point);
    return fetch((window.API_BASE || '') + '/wms-proxy?url=' + encodeURIComponent(wmsUrl))
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.text();
      })
      .then(function (plainText) {
        var features = _parseSoilsText(plainText);
        return { cfg: cfg, features: features };
      })
      .catch(function (err) {
        return { cfg: cfg, features: [], error: err.message };
      });
  }

  // ── Dispatch ─────────────────────────────────────────────────────────────

  function _fetchOne(cfg, map, point) {
    return cfg.restUrl ? _fetchRest(cfg, map, point) : _fetchWms(cfg, map, point);
  }

  // ── Popup HTML ───────────────────────────────────────────────────────────

  function _attrRows(props, attrs) {
    return attrs
      .filter(function (a) {
        var v = props[a.key] !== undefined ? props[a.key] : props[a.key.toUpperCase()];
        return v !== undefined && v !== null && v !== '' && v !== 'null';
      })
      .map(function (a) {
        var v = props[a.key] !== undefined ? props[a.key] : props[a.key.toUpperCase()];
        return '<div class="wfi-attr-row">' +
          '<span class="wfi-attr-label">' + a.label + '</span>' +
          '<span class="wfi-attr-value">'  + v       + '</span>' +
          '</div>';
      }).join('');
  }

  function _buildHtml(results) {
    var hasAny    = results.some(function (r) { return r.features && r.features.length > 0; });
    var hasErrors = results.some(function (r) { return !!r.error; });

    if (!hasAny) {
      if (hasErrors) {
        var errLines = results
          .filter(function (r) { return r.error; })
          .map(function (r) { return '<div class="wfi-error">' + r.cfg.label + ': ' + r.error + '</div>'; })
          .join('');
        return '<div class="wfi-popup">' + errLines + '</div>';
      }
      return '<div class="wfi-popup"><div class="wfi-empty">No overlay data at this location</div></div>';
    }

    var sections = results
      .filter(function (r) { return r.features && r.features.length > 0; })
      .map(function (r) {
        var props = (r.features[0] && r.features[0].properties) || {};
        var rows  = _attrRows(props, r.cfg.attrs);
        var count = r.features.length;

        if (!rows) {
          rows = '<div class="wfi-attr-row"><span class="wfi-attr-label" style="color:#9ca3af">No attributes returned</span></div>';
        }

        return '<div class="wfi-section">' +
          '<div class="wfi-section-header">' +
            '<span class="wfi-dot" style="background:' + r.cfg.color + '"></span>' +
            '<span class="wfi-section-title">' + r.cfg.label + '</span>' +
            (count > 1 ? '<span class="wfi-count">' + count + ' features</span>' : '') +
          '</div>' +
          (r.error ? '<div class="wfi-error">Query failed: ' + r.error + '</div>' : rows) +
          '</div>';
      }).join('');

    return '<div class="wfi-popup">' + sections + '</div>';
  }

  // ── Click handler ────────────────────────────────────────────────────────

  function _onClick(e) {
    var map = window.PS_MAP;
    if (!map) return;

    var state   = window.PS_OVERLAY_LAYERS ? window.PS_OVERLAY_LAYERS.getState() : {};
    var visible = QUERYABLE.filter(function (cfg) { return !!state[cfg.overlayId]; });
    if (visible.length === 0) return;

    if (_popup) _popup.remove();
    _popup = new maplibregl.Popup({
      className:    'wfi-mgl-popup',
      closeButton:  true,
      closeOnClick: true,
      maxWidth:     '300px'
    })
      .setLngLat(e.lngLat)
      .setHTML('<div class="wfi-popup"><div class="wfi-loading"><span class="wfi-spinner"></span>Querying overlays…</div></div>')
      .addTo(map);

    Promise.all(visible.map(function (cfg) { return _fetchOne(cfg, map, e.point); }))
      .then(function (results) {
        if (_popup && _popup.isOpen()) {
          _popup.setHTML(_buildHtml(results));
        }
      });
  }

  // ── Init ─────────────────────────────────────────────────────────────────

  function _waitForMap() {
    var map = window.PS_MAP;
    if (!map) { setTimeout(_waitForMap, 300); return; }
    map.on('click', _onClick);
  }
  _waitForMap();

  // ── Export ───────────────────────────────────────────────────────────────

  window.PS_WMS_FEATURE_INFO = {
    getPopup: function () { return _popup; }
  };
}());
