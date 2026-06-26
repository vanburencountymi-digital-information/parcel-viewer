/**
 * wms-feature-info.js — Unified overlay identify / click popup.
 *
 * Listens for map clicks and reports the NON-parcel layers under the cursor in
 * one popup (parcels keep their dedicated rich info card). Two kinds of layer
 * feed the same popup:
 *
 *   1. Regulatory WMS overlays (remote) — queried over the network:
 *        Flood    FEMA NFHL       ArcGIS REST point query  (JSON natively)
 *        Wetlands USFWS NWI       ArcGIS REST point query  (JSON natively)
 *        Soils    USDA SSURGO     WMS GetFeatureInfo        (text/plain)
 *      All routed through /wms-proxy to avoid CORS restrictions.
 *
 *   2. County PostGIS vector layers (DIC-517) — subdivisions, PLSS, roads,
 *      drains, address points, etc. (registered via DIC-502). These are already
 *      drawn as vector tiles, so we identify them locally with
 *      queryRenderedFeatures against the `<id>-fill`/`-line`/`-circle` layers
 *      and read each hit's attributes from the layer's configured `fields`.
 *
 * Only VISIBLE layers identify (a remote query needs the overlay on; a vector
 * query only returns features MapLibre actually rendered, so layers below their
 * minzoom contribute nothing). When a click overlaps several layers, every
 * matching layer gets its own section.
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
        {
          key: 'FLD_ZONE', label: 'Flood Zone',
          fmt: function (v) {
            var desc = {
              'A':    'No base flood elevation determined',
              'AE':   'Base flood elevation determined',
              'AH':   'Shallow flooding — ponding (BFE determined)',
              'AO':   'Shallow flooding — sheet flow (depth 1–3 ft)',
              'AR':   'Temporary increase due to levee restoration',
              'A99':  'Protected by federal flood control under construction',
              'ANI':  'Area not included in NFIP',
              'V':    'Coastal — wave action, no BFE determined',
              'VE':   'Coastal — wave action, BFE determined',
              'D':    'Possible but undetermined flood hazard',
            }[v.toUpperCase()];
            return 'Zone ' + v + (desc ? ' — ' + desc : '');
          }
        },
        { key: 'ZONE_SUBTY', label: 'Zone Subtype' },
        {
          key: 'SFHA_TF', label: 'Special Flood Hazard Area',
          fmt: function (v) {
            if (v === 'T' || v === true  || v === 'true')  return 'Yes — within the 1% annual chance (100-year) floodplain';
            if (v === 'F' || v === false || v === 'false') return 'No — outside the 100-year floodplain';
            return v;
          }
        },
        {
          key: 'STATIC_BFE', label: 'Base Flood Elevation',
          fmt: function (v) {
            var n = parseFloat(v);
            return (isNaN(n) || n < -9000) ? null : n.toFixed(1) + ' ft NAVD88';
          }
        }
      ],
      suppress: function(props) {
        var zone = props['FLD_ZONE'] || props['fld_zone'] || '';
        return zone.toUpperCase() === 'X';
      }
    },
    {
      overlayId: 'overlay-wetlands',
      label:     'Wetland Classification',
      color:     '#16a34a',
      restUrl:   'https://fwspublicservices.wim.usgs.gov/wetlandsmapservice/rest/services/Wetlands/MapServer/0/query',
      attrs: [
        { key: 'WETLAND_TYPE', label: 'Wetland Type' },
        { key: 'ATTRIBUTE',    label: 'Attribute'    },
        { key: 'ACRES',        label: 'Acres', fmt: function(v) { return parseFloat(v).toFixed(2) + ' ac'; } }
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

  // ── Fetch with timeout ───────────────────────────────────────────────────
  // External overlay servers (USFWS, USDA SSURGO, etc.) occasionally go down or
  // hang. Without a deadline, fetch() can stall for 30s+ and — because the click
  // handler awaits Promise.all — block the entire feature-info popup. Abort after
  // a fixed budget so a dead server fails fast and the others still render.
  var _QUERY_TIMEOUT_MS = 8000;

  function _fetchWithTimeout(url) {
    var ctrl  = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, _QUERY_TIMEOUT_MS);
    return fetch(url, { signal: ctrl.signal })
      .finally(function () { clearTimeout(timer); });
  }

  function _errResult(cfg, err) {
    var msg = (err && err.name === 'AbortError') ? 'timed out' : (err && err.message) || 'unavailable';
    return { cfg: cfg, features: [], error: msg };
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

    return _fetchWithTimeout((window.API_BASE || '') + '/wms-proxy?url=' + encodeURIComponent(restUrl))
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
        return _errResult(cfg, err);
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
    return _fetchWithTimeout((window.API_BASE || '') + '/wms-proxy?url=' + encodeURIComponent(wmsUrl))
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.text();
      })
      .then(function (plainText) {
        var features = _parseSoilsText(plainText);
        return { cfg: cfg, features: features };
      })
      .catch(function (err) {
        return _errResult(cfg, err);
      });
  }

  // ── Dispatch ─────────────────────────────────────────────────────────────

  function _fetchOne(cfg, map, point) {
    return cfg.restUrl ? _fetchRest(cfg, map, point) : _fetchWms(cfg, map, point);
  }

  // ── Popup HTML ───────────────────────────────────────────────────────────

  function _esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function _attrRows(props, attrs) {
    var rows = [];
    attrs.forEach(function (a) {
      var v = props[a.key] !== undefined ? props[a.key] : props[a.key.toUpperCase()];
      if (v === undefined || v === null || v === '' || v === 'null') return;
      var display = a.fmt ? a.fmt(v) : v;
      if (display === null || display === undefined) return; // fmt returning null suppresses the row
      rows.push('<div class="wfi-attr-row">' +
        '<span class="wfi-attr-label">' + _esc(a.label) + '</span>' +
        '<span class="wfi-attr-value">'  + _esc(display) + '</span>' +
        '</div>');
    });
    return rows.join('');
  }

  function _buildHtml(results) {
    var hasAny    = results.some(function (r) { return r.features && r.features.length > 0; });
    var hasErrors = results.some(function (r) { return !!r.error; });

    if (!hasAny) {
      // Nothing useful to show. If layers errored (server down/timeout), capture
      // the failure to the console for debugging but do NOT draw an error popup —
      // a wall of "HTTP 505 / timed out" is noise to the user. A clean miss (no
      // features, no errors) likewise draws nothing.
      if (hasErrors) {
        results
          .filter(function (r) { return r.error; })
          .forEach(function (r) {
            console.warn('[overlay-query] ' + r.cfg.label + ' unavailable: ' + r.error);
          });
      }
      return null;
    }

    var sections = results
      .filter(function (r) { return r.features && r.features.length > 0; })
      .filter(function (r) {
        if (!r.cfg.suppress) return true;
        var props = (r.features[0] && r.features[0].properties) || {};
        return !r.cfg.suppress(props);
      })
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

    if (!sections) return null;
    return '<div class="wfi-popup">' + sections + '</div>';
  }

  // ── County PostGIS vector identify (DIC-517) ─────────────────────────────
  // These layers are already on the map as vector tiles, so identify is a local
  // queryRenderedFeatures — no network call. Results are shaped to match the WMS
  // `{ cfg, features }` contract so they flow through the same _buildHtml path.

  var _PG_GEOM_SUFFIX = ['-fill', '-line', '-circle'];

  // Default section dot when a layer's paint color can't be read.
  var _PG_DEFAULT_COLOR = '#7A3B6B';

  function _county() {
    return (window.PS_CONTEXT && window.PS_CONTEXT.config) || window.COUNTY || {};
  }

  // "twp_range" / "area_sq_ft" → "Twp Range" / "Area Sq Ft". A future per-layer
  // field-label config (DIC-502 discovery) can override these.
  function _prettifyField(name) {
    return String(name == null ? '' : name)
      .replace(/[_-]+/g, ' ')
      .replace(/\b\w/g, function (c) { return c.toUpperCase(); });
  }

  function _sourceConfigForOverlay(o) {
    var fields = Array.isArray(o.fields) ? o.fields : [];
    var idField = o.idField || fields[0] || 'id';
    return {
      id: o.id,
      idField: idField,
      popup: {
        sections: [{
          title: o.label || o.id,
          fields: fields.map(function (k) { return { label: _prettifyField(k), field: k }; }),
        }],
      },
    };
  }

  // The registered PostGIS vector overlays (config-as-data, same source the
  // pg-layers renderer reads).
  function _vectorOverlays() {
    var L = _county().layers || {};
    return (L.overlays || []).filter(function (o) {
      return o && String(o.type || '').toLowerCase() === 'vector';
    });
  }

  // Read the rendered paint color of a pg layer for the section dot. The suffix
  // tells us which paint property holds the color.
  function _pgColor(map, layerId) {
    var prop = /-line$/.test(layerId) ? 'line-color'
             : /-circle$/.test(layerId) ? 'circle-color'
             : 'fill-color';
    try { var c = map.getPaintProperty(layerId, prop); if (typeof c === 'string') return c; } catch (_) {}
    return _PG_DEFAULT_COLOR;
  }

  function _queryPgLayers(map, point) {
    var pg    = window.PS_PG_LAYERS;
    var state = (pg && pg.getState) ? pg.getState() : {};
    var out   = [];

    _vectorOverlays().forEach(function (o) {
      if (!state[o.id]) return;   // only identify layers the user has on

      // The geometry layers that actually exist and are visible right now.
      var layerIds = _PG_GEOM_SUFFIX
        .map(function (s) { return o.id + s; })
        .filter(function (lid) {
          return map.getLayer(lid) && map.getLayoutProperty(lid, 'visibility') !== 'none';
        });
      if (!layerIds.length) return;

      // Thin lines / points need a small pixel tolerance to be clickable;
      // polygons identify at the exact point so we don't grab neighbors.
      var g = (o.geomType || 'polygon').toLowerCase();
      var query = (g === 'line' || g === 'point')
        ? [[point.x - 6, point.y - 6], [point.x + 6, point.y + 6]]
        : point;

      var feats;
      try { feats = map.queryRenderedFeatures(query, { layers: layerIds }); }
      catch (_) { feats = []; }
      if (!feats.length) return;

      // One real feature can hit both -fill and -line; dedup on id + field values.
      var seen = {}, uniq = [];
      feats.forEach(function (f) {
        var p = f.properties || {};
        var key = (f.id != null ? f.id : '') + '|' +
          (o.fields || []).map(function (k) { return p[k]; }).join('|');
        if (seen[key]) return;
        seen[key] = 1;
        uniq.push(f);
      });

      var attrs = (o.fields || []).map(function (k) {
        return { key: k, label: _prettifyField(k) };
      });
      out.push({
        cfg: { label: o.label || o.id, color: _pgColor(map, layerIds[0]), attrs: attrs, source: _sourceConfigForOverlay(o) },
        features: uniq,
      });
    });

    return out;
  }

  function _selectPgFeatureAt(map, point) {
    if (!map || !window.PV_FEATURE_INFO || typeof window.PV_FEATURE_INFO.select !== 'function') return false;
    var pgResults = _queryPgLayers(map, point);
    if (!pgResults.length) return false;
    var first = pgResults[0];
    var feature = first.features && first.features[0];
    if (!feature) return false;
    return window.PV_FEATURE_INFO.select(first.cfg.source, feature, { title: first.cfg.label });
  }

  // ── Click handler ────────────────────────────────────────────────────────

  function _onClick(e) {
    var map = window.PS_MAP;
    if (!map) return;

    var state      = window.PS_OVERLAY_LAYERS ? window.PS_OVERLAY_LAYERS.getState() : {};
    var visibleWms = QUERYABLE.filter(function (cfg) { return !!state[cfg.overlayId]; });
    var pgResults  = _queryPgLayers(map, e.point);   // synchronous, local
    if (visibleWms.length === 0 && pgResults.length === 0) return;

    _selectPgFeatureAt(map, e.point);

    if (visibleWms.length === 0) return;

    if (_popup) { _popup.remove(); _popup = null; }

    Promise.all(visibleWms.map(function (cfg) { return _fetchOne(cfg, map, e.point); }))
      .then(function (wmsResults) {
        var html = _buildHtml(wmsResults);
        if (html === null) return;
        _popup = new maplibregl.Popup({
          className:    'wfi-mgl-popup',
          closeButton:  true,
          closeOnClick: true,
          maxWidth:     '300px'
        })
          .setLngLat(e.lngLat)
          .setHTML(html)
          .addTo(map);
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
    getPopup: function () { return _popup; },
    selectVectorFeatureAt: function (point) { return _selectPgFeatureAt(window.PS_MAP, point); }
  };
}());
