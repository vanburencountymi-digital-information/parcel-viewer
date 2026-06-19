/**
 * pg-layers.js — config-driven PostGIS vector overlays (DIC-502).
 *
 * Renders the county's PostGIS layers (served by Martin as `<name>_tiles`
 * function sources, MVT layer `<name>`) as toggleable vector overlays in the
 * Layers panel. Unlike overlay-layers.js (hardcoded federal WMS rasters), this
 * module is entirely DATA-DRIVEN: it reads COUNTY.layers.overlays entries of
 * type 'vector' and paints them from COUNTY.styling.layers[id] (DIC-460). New
 * layers added through the Admin Console appear here with no code change.
 *
 * Each vector overlay entry:
 *   { id, label, type:'vector', source:'<name>_tiles', sourceLayer:'<name>',
 *     geomType:'polygon'|'line'|'point', minZoom, default }
 *
 * Layers are added lazily (only when first toggled on) and inserted below
 * 'parcels-fill' so parcels stay on top. State persists in localStorage.
 *
 * Exposes: window.PS_PG_LAYERS { setOverlay, getState, overlays }
 */
(function () {
  'use strict';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function getMap() { return window.PS_MAP || null; }
  function isDark() { return document.documentElement.getAttribute('data-theme') === 'dark'; }

  // Resolve the Martin tile base the same way map.js does.
  function martinBase() {
    var m = (window.PS_CONFIG && window.PS_CONFIG.MARTIN_URL) || '/tiles';
    return /^https?:\/\//.test(m) ? m : window.location.origin + m;
  }

  // The vector overlays registered in the county config (config-as-data).
  function vectorOverlays() {
    var L = (window.COUNTY && window.COUNTY.layers) || {};
    return (L.overlays || []).filter(function (o) {
      return o && String(o.type || '').toLowerCase() === 'vector';
    });
  }

  // Paint for a layer comes from styling.layers[id] (DIC-460), theme-aware.
  function paintColors(id) {
    var sl = (window.COUNTY && window.COUNTY.styling && window.COUNTY.styling.layers) || {};
    var p = (sl[id] && sl[id].paint) || {};
    var t = (isDark() ? p.dark : p.light) || p.light || {};
    var fill = t.fill || '#7A3B6B';
    return { fill: fill, stroke: t.stroke || fill };
  }

  var LS = 'pg_layers_state';
  var _state = {};   // { id: bool } — what the user wants on
  var _added = {};   // { id: bool } — what's been added to the map

  function save() { try { localStorage.setItem(LS, JSON.stringify(_state)); } catch (_) {} }
  function load() {
    var s = {};
    try { s = JSON.parse(localStorage.getItem(LS) || '{}'); } catch (_) {}
    vectorOverlays().forEach(function (o) {
      _state[o.id] = (o.id in s) ? !!s[o.id] : !!o.default;
    });
  }

  // Lazily add the source + style layers for an overlay the first time it's
  // turned on. Geometry type decides which MapLibre layer(s) to create.
  function addOverlay(o) {
    var map = getMap();
    if (!map || _added[o.id]) return;
    var srcId = 'pg-' + o.id;
    if (!map.getSource(srcId)) {
      map.addSource(srcId, {
        type: 'vector',
        tiles: [martinBase() + '/' + o.source + '/{z}/{x}/{y}'],
        minzoom: 0, maxzoom: 22,
      });
    }
    var c = paintColors(o.id);
    var sl = o.sourceLayer || o.source;
    var mz = o.minZoom || 0;
    var vis = _state[o.id] ? 'visible' : 'none';
    var before = map.getLayer('parcels-fill') ? 'parcels-fill' : undefined;
    var g = (o.geomType || 'polygon').toLowerCase();

    if (g === 'polygon') {
      // outlineOnly: skip the fill (good for grid/boundary layers like PLSS
      // sections that would otherwise tint the whole map).
      if (!o.outlineOnly && !map.getLayer(o.id + '-fill')) {
        map.addLayer({ id: o.id + '-fill', type: 'fill', source: srcId, 'source-layer': sl,
          minzoom: mz, paint: { 'fill-color': c.fill, 'fill-opacity': 0.22 },
          layout: { visibility: vis } }, before);
      }
      if (!map.getLayer(o.id + '-line')) {
        map.addLayer({ id: o.id + '-line', type: 'line', source: srcId, 'source-layer': sl,
          minzoom: mz, paint: { 'line-color': c.stroke, 'line-width': 1.2 },
          layout: { visibility: vis } }, before);
      }
    } else if (g === 'line') {
      if (!map.getLayer(o.id + '-line')) {
        map.addLayer({ id: o.id + '-line', type: 'line', source: srcId, 'source-layer': sl,
          minzoom: mz, paint: { 'line-color': c.stroke, 'line-width': 1.4 },
          layout: { visibility: vis } }, before);
      }
    } else { // point
      if (!map.getLayer(o.id + '-circle')) {
        map.addLayer({ id: o.id + '-circle', type: 'circle', source: srcId, 'source-layer': sl,
          minzoom: mz, paint: { 'circle-color': c.fill, 'circle-radius': 3,
            'circle-stroke-color': c.stroke, 'circle-stroke-width': 0.8 },
          layout: { visibility: vis } }, before);
      }
    }
    _added[o.id] = true;
  }

  var SUFFIXES = ['-fill', '-line', '-circle'];

  function setOverlay(id, on) {
    _state[id] = !!on;
    save();
    var cb = document.getElementById('pg-' + id + '-toggle');
    if (cb) cb.checked = !!on;
    var map = getMap();
    if (!map) return;   // waitForMap picks it up later
    var o = vectorOverlays().filter(function (x) { return x.id === id; })[0];
    if (!o) return;
    if (on) addOverlay(o);
    SUFFIXES.forEach(function (suf) {
      if (map.getLayer(id + suf)) map.setLayoutProperty(id + suf, 'visibility', on ? 'visible' : 'none');
    });
  }

  // Re-apply theme-dependent colors when the viewer toggles dark/light.
  function restyle() {
    var map = getMap();
    if (!map) return;
    vectorOverlays().forEach(function (o) {
      if (!_added[o.id]) return;
      var c = paintColors(o.id);
      if (map.getLayer(o.id + '-fill')) map.setPaintProperty(o.id + '-fill', 'fill-color', c.fill);
      if (map.getLayer(o.id + '-line')) map.setPaintProperty(o.id + '-line', 'line-color', c.stroke);
      if (map.getLayer(o.id + '-circle')) {
        map.setPaintProperty(o.id + '-circle', 'circle-color', c.fill);
        map.setPaintProperty(o.id + '-circle', 'circle-stroke-color', c.stroke);
      }
    });
  }

  // Inject a "County Layers (PostGIS)" section into the Layers panel, above the
  // Parcel Labels tool. Built from config so registering a layer in the console
  // surfaces it here with no markup change.
  function buildUI() {
    var ov = vectorOverlays();
    if (!ov.length) return;
    var pane = document.getElementById('mcp-pane-layers');
    if (!pane || document.getElementById('pg-layers-section')) return;
    var sec = document.createElement('div');
    sec.id = 'pg-layers-section';
    var html = '<div class="overlay-divider"></div>' +
      '<div class="overlay-section-title">County Layers (PostGIS)</div>';
    ov.forEach(function (o) {
      html += '<label class="mcp-toggle-row"><input type="checkbox" id="pg-' + esc(o.id) + '-toggle"' +
        (_state[o.id] ? ' checked' : '') + '> ' + esc(o.label || o.id) + '</label>';
      if (o.minZoom) html += '<div class="overlay-hint">Visible at zoom ' + esc(o.minZoom) + '+</div>';
    });
    sec.innerHTML = html;
    var anchor = pane.querySelector('.plbl-divider');
    if (anchor) pane.insertBefore(sec, anchor); else pane.appendChild(sec);
    ov.forEach(function (o) {
      var cb = document.getElementById('pg-' + o.id + '-toggle');
      if (cb) cb.addEventListener('change', function () { setOverlay(o.id, this.checked); });
    });
  }

  function waitForMap() {
    if (!getMap()) { setTimeout(waitForMap, 300); return; }
    vectorOverlays().forEach(function (o) { if (_state[o.id]) addOverlay(o); });
  }

  function observeTheme() {
    try {
      new MutationObserver(restyle).observe(document.documentElement,
        { attributes: true, attributeFilter: ['data-theme'] });
    } catch (_) {}
  }

  load();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', buildUI);
  else buildUI();
  waitForMap();
  observeTheme();

  window.PS_PG_LAYERS = {
    setOverlay: setOverlay,
    getState: function () { return Object.assign({}, _state); },
    overlays: function () { return vectorOverlays().map(function (o) { return { id: o.id, label: o.label }; }); },
  };
}());
