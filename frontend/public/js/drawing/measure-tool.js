/**
 * measure-tool.js — Measurement Tab (Phase M1)
 *
 * Implements the complete Measurement tab with Basic and Advanced tool sections.
 *
 * Basic tools:
 *   Quick Parcel Info, Measure Area, Measure Distance,
 *   Point Coordinates, Dimension Line
 *
 * Advanced tools (collapsible):
 *   Bearing & Distance Query, Perpendicular Distance, Arc/Radius,
 *   Running Dimension, Offset Line (stub), Angle Annotation,
 *   Auto-Dimension Parcel, Legal Description Match (stub)
 *
 * Architecture:
 *   - IIFE, window.PS_MEASURE_TOOL, matches existing module pattern
 *   - Reuses PS_SNAPPING_ENGINE, PS_ANNOTATION_STORE, PS_UNDO_REDO
 *   - Separate measure-preview-source/layers (does not conflict with draw-preview-source)
 *   - Shared snap-indicator-source (same as drawing-tools.js — cleared by each)
 *   - Measurement HUD: #msr-hud positioned in #panel-map
 *   - featureType values all prefixed 'measure-'
 *
 * Depends on: turf.js, annotation-store.js, undo-redo.js, snapping-engine.js, map.js
 * Optional:   proj4.js (for State Plane coordinates; degrades gracefully if absent)
 * Exposed as: window.PS_MEASURE_TOOL
 */
(function () {
  'use strict';

  // ══ Constants ══════════════════════════════════════════════════════════════

  /** Default collinearity threshold for Auto-Dimension Parcel (degrees).
   *  This is the authoritative value — import from here if types.ts existed. */
  var COLLINEARITY_THRESHOLD_DEG = 0.5;
  var DEFAULT_MIN_SEGMENT_FT     = 10;
  var MSR_PREVIEW_SRC            = 'measure-preview-source';
  var LS_ADVANCED_KEY            = 'measureTab_advancedExpanded';
  var LS_BEARING_FMT             = 'ps_bearingFormat';
  var LS_UNITS_KEY               = 'ps_measureUnits';
  var LS_ANNOTATE_KEY            = 'ps_measureAnnotate';
  var FEET_PER_METER             = 3.28084;
  var SQ_FT_PER_ACRE             = 43560;
  var SQ_M_PER_ACRE              = 4046.8564;
  var SQ_M_PER_SQ_FT             = 0.09290304;

  // Michigan State Plane South (EPSG:6497, us-ft) — for Point Coordinates tool
  var MI_STATE_PLANE_DEF = '+proj=lcc +lat_0=41.5 +lon_0=-84.3666666666667 ' +
    '+lat_1=42.1 +lat_2=43.6667 +x_0=4000000 +y_0=0 +ellps=GRS80 +units=us-ft +no_defs';
  var WGS84_DEF = '+proj=longlat +datum=WGS84 +no_defs';

  // ══ State ══════════════════════════════════════════════════════════════════

  var _activeTool        = null;   // current tool name string
  var _eventsWired       = false;  // panel DOM events wired once
  var _mapEventsWired    = false;  // map events wired on first tab activate
  var _drawCoords        = [];     // in-progress click coordinates (multi-click tools)
  var _tempMode          = false;  // shift-activate: HUD only, auto-clear on next tool
  var _stepCount         = 0;      // for step-based tools (0 = waiting for first click)
  var _stepPoints        = [];     // [lng,lat] points gathered so far in step tools
  var _lastSaveCallback  = null;   // set by showHud() so Save button can call it
  var _hudEl             = null;   // #msr-hud element reference
  var _advancedExpanded  = false;
  var _bdHistory         = [];     // bearing & distance query history (last 5)
  var _lastAnnotationIds = [];     // IDs committed by the most recent finish — for "Clear This Measurement"

  var _settings = {
    annotateDistance: true,
    annotateBearing:  false,
    bearingFormat:    'quadrant',  // 'quadrant' | 'azimuth'
    units:            'feet',      // 'feet' | 'miles'
  };

  // ══ Accessors ══════════════════════════════════════════════════════════════

  function getMap()   { return window.PS_MAP              || null; }
  function getStore() { return window.PS_ANNOTATION_STORE || null; }
  function getSnap()  { return window.PS_SNAPPING_ENGINE  || null; }

  // ══ Number / unit helpers ══════════════════════════════════════════════════

  function toFeet(dist, unit) {
    var table = { feet:1, ft:1, chains:66, ch:66, links:0.66, lk:0.66,
                  miles:5280, mi:5280, meters:FEET_PER_METER, m:FEET_PER_METER };
    return dist * (table[unit] || 1);
  }
  function toMeters(ft) { return ft / FEET_PER_METER; }

  function formatDist(ft) {
    if (_settings.units === 'miles' || ft >= 5280) {
      return (ft / 5280).toFixed(3) + ' mi (' + ft.toFixed(2) + ' ft)';
    }
    return ft.toFixed(2) + ' ft';
  }
  function formatDistShort(ft) {
    if (ft >= 5280) return (ft / 5280).toFixed(3) + ' mi';
    return ft.toFixed(2) + ' ft';
  }
  function formatArea(sqft) {
    if (sqft >= SQ_FT_PER_ACRE) {
      return (sqft / SQ_FT_PER_ACRE).toFixed(2) + ' acres  (' +
             Math.round(sqft).toLocaleString() + ' sq ft)';
    }
    return Math.round(sqft).toLocaleString() + ' sq ft';
  }

  function pad2(n) { return n < 10 ? '0' + n : String(n); }

  // ══ Bearing helpers ════════════════════════════════════════════════════════

  function azimuthBetween(from, to) {
    // turf.bearing returns -180..180; normalise to 0..360
    return ((turf.bearing(turf.point(from), turf.point(to)) % 360) + 360) % 360;
  }

  function azimuthToQuadrant(az) {
    az = ((az % 360) + 360) % 360;
    var ns, ew, deg;
    if      (az <= 90)  { ns = 'N'; ew = 'E'; deg = az; }
    else if (az <= 180) { ns = 'S'; ew = 'E'; deg = 180 - az; }
    else if (az <= 270) { ns = 'S'; ew = 'W'; deg = az - 180; }
    else                { ns = 'N'; ew = 'W'; deg = 360 - az; }
    var d  = Math.floor(deg);
    var mf = (deg - d) * 60;
    var m  = Math.floor(mf);
    var s  = Math.round((mf - m) * 60);
    if (s >= 60) { s -= 60; m++; }
    if (m >= 60) { m -= 60; d++; }
    return ns + ' ' + d + '°' + pad2(m) + '′' + pad2(s) + '″ ' + ew;
  }

  function formatBearing(az) {
    if (_settings.bearingFormat === 'azimuth') {
      return (((az % 360) + 360) % 360).toFixed(3) + '°';
    }
    return azimuthToQuadrant(az);
  }

  function backBearing(az) { return ((az + 180) % 360 + 360) % 360; }

  /**
   * Compute the MapLibre text-rotate value (degrees) for a label placed along
   * the segment from → to.  Always returns a value in [–90, 90] so the text
   * reads left-to-right regardless of which direction the line was drawn.
   * @param {[number,number]} from  [lng, lat]
   * @param {[number,number]} to    [lng, lat]
   * @returns {number}  rotation in degrees (MapLibre convention: clockwise positive)
   */
  function computeLabelRotation(from, to) {
    var az  = azimuthBetween(from, to);
    var rot = az - 90;
    if (rot < -90 || rot > 90) rot += 180;
    return rot;
  }

  // ══ Snap helpers ═══════════════════════════════════════════════════════════

  function showSnapIndicator(lngLat) {
    var map = getMap();
    if (!map) return;
    var src = map.getSource('snap-indicator-source');
    if (!src) return;
    src.setData({
      type: 'FeatureCollection',
      features: [{ type: 'Feature',
        geometry: { type: 'Point', coordinates: [lngLat[0], lngLat[1]] },
        properties: {} }],
    });
  }

  function clearSnapIndicator() {
    var map = getMap();
    if (!map) return;
    var src = map.getSource('snap-indicator-source');
    if (src) src.setData({ type: 'FeatureCollection', features: [] });
  }

  function snapLngLat(lngLat) {
    var engine = getSnap();
    var map    = getMap();
    var raw    = [lngLat.lng !== undefined ? lngLat.lng : lngLat[0],
                  lngLat.lat !== undefined ? lngLat.lat : lngLat[1]];
    if (!engine || !map || !engine.config.enabled) { clearSnapIndicator(); return raw; }
    var result = engine.snap(raw, map, _drawCoords);
    if (result) { showSnapIndicator(result.lngLat); return result.lngLat; }
    clearSnapIndicator();
    return raw;
  }

  // ══ Preview layer ══════════════════════════════════════════════════════════

  function ensurePreviewLayers() {
    var map = getMap();
    if (!map) return;
    if (!map.getSource(MSR_PREVIEW_SRC)) {
      map.addSource(MSR_PREVIEW_SRC, { type: 'geojson',
        data: { type: 'FeatureCollection', features: [] } });
    }
    if (!map.getLayer('msr-preview-fill')) {
      map.addLayer({ id: 'msr-preview-fill', type: 'fill', source: MSR_PREVIEW_SRC,
        filter: ['==', ['geometry-type'], 'Polygon'],
        paint: { 'fill-color': '#16a34a', 'fill-opacity': 0.12 } });
    }
    if (!map.getLayer('msr-preview-line')) {
      map.addLayer({ id: 'msr-preview-line', type: 'line', source: MSR_PREVIEW_SRC,
        filter: ['in', ['geometry-type'], ['literal', ['LineString', 'Polygon']]],
        paint: { 'line-color': '#16a34a', 'line-width': 2, 'line-opacity': 0.8 } });
    }
    if (!map.getLayer('msr-preview-circle')) {
      map.addLayer({ id: 'msr-preview-circle', type: 'circle', source: MSR_PREVIEW_SRC,
        filter: ['==', ['get', 'role'], 'vertex'],
        paint: { 'circle-radius': 4, 'circle-color': '#fff',
                 'circle-stroke-color': '#16a34a', 'circle-stroke-width': 2 } });
    }
    if (!map.getLayer('msr-preview-label')) {
      map.addLayer({ id: 'msr-preview-label', type: 'symbol', source: MSR_PREVIEW_SRC,
        filter: ['!=', ['get', 'label'], null],
        layout: {
          'text-field':          ['get', 'label'],
          'text-font':           ['Open Sans Regular', 'Arial Unicode MS Regular'],
          'text-size':           11,
          'text-allow-overlap':  true,
          'text-ignore-placement': true,
          'text-offset':         [0, -1.2],
        },
        paint: {
          'text-color': '#166534',
          'text-halo-color': '#fff',
          'text-halo-width': 1.5,
        } });
    }
  }

  function setPreview(geojson) {
    var map = getMap();
    if (!map) return;
    ensurePreviewLayers();
    var src = map.getSource(MSR_PREVIEW_SRC);
    if (src) src.setData(geojson || { type: 'FeatureCollection', features: [] });
  }

  function clearPreview() {
    setPreview(null);
  }

  // ══ Measurement HUD ════════════════════════════════════════════════════════

  function getHud() {
    if (!_hudEl) _hudEl = document.getElementById('msr-hud');
    return _hudEl;
  }

  /**
   * Show the result HUD with structured content.
   * @param {string}        toolLabel   Header text (tool name)
   * @param {string}        bodyHtml    Inner HTML for the content area
   * @param {Function|null} saveCallback  Called when Save button is clicked; null = button hidden
   */
  function showHud(toolLabel, bodyHtml, saveCallback) {
    var el = getHud();
    if (!el) return;
    _lastSaveCallback = saveCallback || null;

    el.querySelector('.msr-hud-title').textContent = toolLabel;
    el.querySelector('.msr-hud-body').innerHTML    = bodyHtml;

    var saveBtn = el.querySelector('.msr-hud-save');
    if (saveBtn) {
      var canSave = !!saveCallback &&
                    (_settings.annotateDistance || _settings.annotateBearing);
      saveBtn.style.display = saveCallback ? '' : 'none';
      saveBtn.disabled      = !canSave;
    }

    var tempBadge = el.querySelector('.msr-hud-temp');
    if (tempBadge) tempBadge.hidden = !_tempMode;

    el.hidden = false;
  }

  function hideHud() {
    var el = getHud();
    if (el) el.hidden = true;
    _lastSaveCallback = null;
  }

  function updateHudSaveState() {
    var el = getHud();
    if (!el) return;
    var saveBtn = el.querySelector('.msr-hud-save');
    if (saveBtn && saveBtn.style.display !== 'none') {
      saveBtn.disabled = !_lastSaveCallback ||
                         (!_settings.annotateDistance && !_settings.annotateBearing);
    }
  }

  /** Build a label string for annotation based on current settings. */
  function buildLabel(distFt, azimuth) {
    var parts = [];
    if (_settings.annotateBearing && azimuth !== undefined) parts.push(formatBearing(azimuth));
    if (_settings.annotateDistance && distFt  !== undefined) parts.push(formatDistShort(distFt));
    return parts.join('\n');
  }

  // ══ Settings load / save ═══════════════════════════════════════════════════

  function loadSettings() {
    try {
      var fmt = localStorage.getItem(LS_BEARING_FMT);
      if (fmt === 'azimuth' || fmt === 'quadrant') _settings.bearingFormat = fmt;

      var units = localStorage.getItem(LS_UNITS_KEY);
      if (units === 'miles' || units === 'feet') _settings.units = units;

      var ann = JSON.parse(localStorage.getItem(LS_ANNOTATE_KEY) || 'null');
      if (ann && typeof ann === 'object') {
        if (typeof ann.distance === 'boolean') _settings.annotateDistance = ann.distance;
        if (typeof ann.bearing  === 'boolean') _settings.annotateBearing  = ann.bearing;
      }

      var adv = localStorage.getItem(LS_ADVANCED_KEY);
      _advancedExpanded = (adv === 'true');
    } catch (_) { /* ignore storage errors */ }
  }

  function saveSettings() {
    try {
      localStorage.setItem(LS_BEARING_FMT, _settings.bearingFormat);
      localStorage.setItem(LS_UNITS_KEY,   _settings.units);
      localStorage.setItem(LS_ANNOTATE_KEY, JSON.stringify({
        distance: _settings.annotateDistance,
        bearing:  _settings.annotateBearing,
      }));
    } catch (_) {}
  }

  function saveAdvancedPref() {
    try { localStorage.setItem(LS_ADVANCED_KEY, String(_advancedExpanded)); } catch (_) {}
  }

  // ══ Tool activation / deactivation ═════════════════════════════════════════

  function deactivateTool() {
    if (!_activeTool) return;
    _activeTool   = null;
    _drawCoords   = [];
    _stepCount    = 0;
    _stepPoints   = [];
    _tempMode     = false;
    clearPreview();
    clearSnapIndicator();
    hideHud();

    var map = getMap();
    if (map) map.getCanvas().style.cursor = '';

    // Release activeDrawTool gate if we held it
    if (window.PS_STATE && window.PS_STATE.activeDrawTool === 'measure') {
      window.PS_STATE.activeDrawTool = null;
    }

    updateToolButtons();
  }

  function activateTool(toolName, opts) {
    deactivateTool();
    _activeTool = toolName;
    _tempMode   = !!(opts && opts.temp);
    _drawCoords = [];
    _stepCount  = 0;
    _stepPoints = [];

    if (window.PS_STATE) window.PS_STATE.activeDrawTool = 'measure';

    var map = getMap();
    if (map) map.getCanvas().style.cursor = 'crosshair';

    updateToolButtons();

    // Per-tool startup
    switch (toolName) {
      case 'coordinates':
        showHud('📍 Coordinates',
          '<div class="msr-hud-hint">Click any point (snaps to vertices).</div>', null);
        break;
      case 'measure-area':
        showHud('□ Measure Area',
          '<div class="msr-hud-hint">Click vertices (3+ needed). Press Enter to finish.</div>', null);
        break;
      case 'measure-dist':
        showHud('📏 Measure Distance',
          '<div class="msr-hud-hint">Click waypoints (2+ needed). Press Enter to finish.</div>', null);
        break;
      case 'dimension-line':
        _stepCount = 0;
        showHud('↔️ Dimension Line',
          '<div class="msr-hud-hint">Click start point.</div>', null);
        break;
      case 'bearing-dist':
        _stepCount = 0;
        showHud('🧭 Bearing &amp; Distance',
          '<div class="msr-hud-hint">Click start point.</div>', null);
        break;
      case 'perpendicular':
        _stepCount = 0;
        showHud('📐 Perpendicular',
          '<div class="msr-hud-hint">Click line start.</div>', null);
        break;
      case 'arc-radius':
        _stepCount = 0;
        showHud('🔄 Arc / Radius',
          '<div class="msr-hud-hint">Click first point on arc.</div>', null);
        break;
      case 'running-dim':
        showHud('📏 Running Dimension',
          '<div class="msr-hud-hint">Click waypoints (2+ needed). Press Enter to finish.</div>', null);
        break;
      case 'angle':
        _stepCount = 0;
        // Tweak 5: new click order — ray1 endpoint → vertex → ray2 endpoint
        showHud('📐 Angle',
          '<div class="msr-hud-hint">Click first ray endpoint.</div>', null);
        break;
      case 'auto-dim':
        showHud('⬡ Dimension Parcel',
          '<div class="msr-hud-hint">Click a parcel to auto-dimension it,\nor click Run if a parcel is already selected.</div>', null);
        break;
    }
  }

  // ══ Tool: Measure Area ═════════════════════════════════════════════════════

  function updateAreaPreview() {
    if (_drawCoords.length < 2) { clearPreview(); return; }
    var features = [];
    // Line so far
    features.push({ type: 'Feature',
      geometry: { type: 'LineString', coordinates: _drawCoords },
      properties: {} });
    // Closing edge + fill if ≥ 3 points
    if (_drawCoords.length >= 3) {
      var closed = _drawCoords.concat([_drawCoords[0]]);
      features.push({ type: 'Feature',
        geometry: { type: 'Polygon', coordinates: [closed] },
        properties: { role: null, label: null } });
    }
    // Vertex dots
    _drawCoords.forEach(function (c, i) {
      features.push({ type: 'Feature',
        geometry: { type: 'Point', coordinates: c },
        properties: { role: 'vertex', label: null } });
    });
    setPreview({ type: 'FeatureCollection', features: features });
  }

  function finishMeasureArea() {
    if (_drawCoords.length < 3) { deactivateTool(); return; }
    var closed = _drawCoords.concat([_drawCoords[0]]);
    var poly   = turf.polygon([closed]);
    var sqft   = turf.area(poly) / SQ_M_PER_SQ_FT;
    var perimFt = 0;
    try {
      perimFt = turf.length(turf.polygonToLine(poly), { units: 'feet' });
    } catch (_) {}
    var bbox = turf.bbox(poly);
    var bboxW = turf.distance(turf.point([bbox[0],bbox[1]]), turf.point([bbox[2],bbox[1]]), { units: 'feet' });
    var bboxH = turf.distance(turf.point([bbox[0],bbox[1]]), turf.point([bbox[0],bbox[3]]), { units: 'feet' });
    var dimL  = Math.max(bboxW, bboxH);
    var dimS  = Math.min(bboxW, bboxH);

    // Auto-save immediately — no "Save to Map" button required
    _lastAnnotationIds = [];
    var label = _settings.annotateDistance ? formatArea(sqft) : null;
    var id = addAnnotation({
      type: 'Feature',
      geometry: { type: 'Polygon', coordinates: [closed] },
      properties: {
        featureType: 'measure-area', label: label, labelAuto: false,
        style: { strokeColor:'#16a34a', strokeWidth:2, strokeDash:'solid',
                 fillColor:'#22c55e', fillOpacity:0.15,
                 fontSize:12, fontColor:'#166534', arrowStart:false, arrowEnd:false },
      },
    });
    if (id) _lastAnnotationIds.push(id);

    var html = '<table class="msr-result-table">' +
      row('Area',      formatArea(sqft)) +
      row('Perimeter', formatDistShort(perimFt)) +
      row('Est. Dims', '~' + Math.round(dimL) + ' ft × ~' + Math.round(dimS) + ' ft') +
      '</table>' +
      '<div class="msr-hud-btn-row">' +
        '<button class="msr-btn msr-btn-danger" id="msr-clear-last-btn">Clear This Measurement</button>' +
      '</div>';

    showHud('□ Measure Area', html, null);
    setTimeout(function () {
      var btn = document.getElementById('msr-clear-last-btn');
      if (btn) btn.addEventListener('click', clearLastMeasurement);
    }, 0);

    // Reset draw state; HUD stays visible (don't call activateTool/deactivateTool here)
    _drawCoords = [];
    clearPreview();
  }

  // ══ Tool: Measure Distance ═════════════════════════════════════════════════

  function totalDistFt(coords) {
    var ft = 0;
    for (var i = 1; i < coords.length; i++) {
      ft += turf.distance(turf.point(coords[i-1]), turf.point(coords[i]), { units: 'feet' });
    }
    return ft;
  }

  function updateDistPreview(cursorCoord) {
    if (_drawCoords.length < 1) { clearPreview(); return; }
    var coords = cursorCoord ? _drawCoords.concat([cursorCoord]) : _drawCoords;
    var features = [];
    // Main polyline
    if (coords.length >= 2) {
      features.push({ type: 'Feature',
        geometry: { type: 'LineString', coordinates: coords }, properties: {} });
    }
    // Per-segment midpoint labels
    for (var i = 1; i < coords.length; i++) {
      var mid = turf.midpoint(turf.point(coords[i-1]), turf.point(coords[i])).geometry.coordinates;
      var segFt = turf.distance(turf.point(coords[i-1]), turf.point(coords[i]), { units: 'feet' });
      var az    = azimuthBetween(coords[i-1], coords[i]);
      var lbl   = buildLabel(segFt, az) || formatDistShort(segFt);
      features.push({ type: 'Feature',
        geometry: { type: 'Point', coordinates: mid },
        properties: { role: null, label: lbl } });
    }
    // Vertex dots
    coords.forEach(function (c) {
      features.push({ type: 'Feature',
        geometry: { type: 'Point', coordinates: c },
        properties: { role: 'vertex', label: null } });
    });
    setPreview({ type: 'FeatureCollection', features: features });
  }

  function finishMeasureDistance() {
    if (_drawCoords.length < 2) { deactivateTool(); return; }
    var coords = _drawCoords.slice();
    var segFts = [];
    for (var i = 1; i < coords.length; i++) {
      segFts.push(turf.distance(turf.point(coords[i-1]), turf.point(coords[i]), { units: 'feet' }));
    }
    var total   = segFts.reduce(function (a, b) { return a + b; }, 0);
    var longest = Math.max.apply(null, segFts);
    var shortest= Math.min.apply(null, segFts);

    // Auto-save immediately — no "Save to Map" button required
    _lastAnnotationIds = [];
    var lineId = addAnnotation({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: coords },
      properties: {
        featureType: 'measure-distance', label: null, labelAuto: false,
        style: { strokeColor:'#16a34a', strokeWidth:2, strokeDash:'solid',
                 fillColor:'#22c55e', fillOpacity:0, fontSize:12,
                 fontColor:'#166534', arrowStart:false, arrowEnd:false },
      },
    });
    if (lineId) _lastAnnotationIds.push(lineId);

    // Per-segment midpoint labels (with bearing-aligned rotation)
    for (var j = 1; j < coords.length; j++) {
      var mid   = turf.midpoint(turf.point(coords[j-1]), turf.point(coords[j])).geometry.coordinates;
      var segFt = turf.distance(turf.point(coords[j-1]), turf.point(coords[j]), { units: 'feet' });
      var az    = azimuthBetween(coords[j-1], coords[j]);
      var lbl   = buildLabel(segFt, az);
      if (lbl) {
        var rot   = computeLabelRotation(coords[j-1], coords[j]);
        var lblId = addLabelAnnotation(mid, lbl, 'measure-distance', rot);
        if (lblId) _lastAnnotationIds.push(lblId);
      }
    }

    var html = '<table class="msr-result-table">' +
      row('Total Distance', formatDist(total)) +
      row('Segments',       String(segFts.length)) +
      row('Longest',        formatDistShort(longest)) +
      row('Shortest',       formatDistShort(shortest)) +
      '</table>' +
      '<div class="msr-hud-btn-row">' +
        '<button class="msr-btn msr-btn-danger" id="msr-clear-last-btn">Clear This Measurement</button>' +
      '</div>';

    showHud('📏 Measure Distance', html, null);
    setTimeout(function () {
      var btn = document.getElementById('msr-clear-last-btn');
      if (btn) btn.addEventListener('click', clearLastMeasurement);
    }, 0);

    // Reset draw state; HUD stays visible
    _drawCoords = [];
    clearPreview();
  }

  // ══ Tool: Point Coordinates ════════════════════════════════════════════════

  function decDegToStr(val, posDir, negDir) {
    var d = Math.abs(val).toFixed(6);
    return d + '° ' + (val >= 0 ? posDir : negDir);
  }

  function decToDMS(val, posDir, negDir) {
    var abs = Math.abs(val);
    var d   = Math.floor(abs);
    var mf  = (abs - d) * 60;
    var m   = Math.floor(mf);
    var s   = ((mf - m) * 60).toFixed(2);
    return d + '° ' + pad2(m) + '′ ' + s + '″ ' + (val >= 0 ? posDir : negDir);
  }

  function coordsToStatePlane(lng, lat) {
    if (!window.proj4) return null;
    try {
      var xy = window.proj4(WGS84_DEF, MI_STATE_PLANE_DEF, [lng, lat]);
      return { northing: xy[1], easting: xy[0] };
    } catch (_) { return null; }
  }

  function handleCoordinatesClick(lngLat) {
    var lng = lngLat[0], lat = lngLat[1];
    var dd  = decDegToStr(lat, 'N', 'S') + ',&nbsp;&nbsp;' + decDegToStr(lng, 'E', 'W');
    var dms = decToDMS(lat, 'N', 'S') + ',&nbsp;&nbsp;' + decToDMS(lng, 'E', 'W');
    var sp  = coordsToStatePlane(lng, lat);

    var snapSnip = '';

    var html =
      '<div class="msr-coord-block">' +
        '<div class="msr-coord-label">Decimal Degrees</div>' +
        '<div class="msr-coord-value">' + dd + '</div>' +
        '<button class="msr-copy-btn" data-copy="' + lat.toFixed(6) + '° N, ' + Math.abs(lng).toFixed(6) + '° W">Copy</button>' +
      '</div>' +
      '<div class="msr-coord-block">' +
        '<div class="msr-coord-label">Degrees Minutes Seconds</div>' +
        '<div class="msr-coord-value">' + dms + '</div>' +
        '<button class="msr-copy-btn" data-copy="' + decToDMS(lat,'N','S').replace(/′/g,'\'').replace(/″/g,'"').replace(/°/g,'°') + ', ' + decToDMS(lng,'E','W').replace(/′/g,'\'').replace(/″/g,'"').replace(/°/g,'°') + '">Copy</button>' +
      '</div>';

    if (sp) {
      html +=
        '<div class="msr-coord-block">' +
          '<div class="msr-coord-label">Michigan State Plane South (EPSG:6497, ft)</div>' +
          '<div class="msr-coord-value">Northing: ' + sp.northing.toFixed(1) + ' ft<br>Easting: &nbsp;' + sp.easting.toFixed(1) + ' ft</div>' +
          '<button class="msr-copy-btn" data-copy="N ' + sp.northing.toFixed(1) + ', E ' + sp.easting.toFixed(1) + '">Copy</button>' +
        '</div>';
    } else {
      html += '<div class="msr-coord-hint">State Plane unavailable (proj4.js not loaded)</div>';
    }

    html +=
      '<div class="msr-hud-btn-row"><button class="msr-btn" id="msr-copy-all-btn">Copy All</button></div>';

    showHud('📍 Coordinates', html, null);

    // Wire copy buttons
    setTimeout(function () {
      var hud = getHud();
      if (!hud) return;
      hud.querySelectorAll('.msr-copy-btn').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var text = this.dataset.copy;
          if (navigator.clipboard) {
            navigator.clipboard.writeText(text).catch(function () {});
          }
          btn.textContent = 'Copied!';
          setTimeout(function () { btn.textContent = 'Copy'; }, 1500);
        });
      });
      var allBtn = document.getElementById('msr-copy-all-btn');
      if (allBtn) {
        allBtn.addEventListener('click', function () {
          var all = 'Decimal Degrees: ' + lat.toFixed(6) + '° N, ' + Math.abs(lng).toFixed(6) + '° W\n' +
                    'DMS: ' + decToDMS(lat,'N','S') + ', ' + decToDMS(lng,'E','W');
          if (sp) all += '\nState Plane (ft): N ' + sp.northing.toFixed(1) + ', E ' + sp.easting.toFixed(1);
          if (navigator.clipboard) navigator.clipboard.writeText(all).catch(function () {});
          allBtn.textContent = 'Copied!';
          setTimeout(function () { allBtn.textContent = 'Copy All'; }, 1500);
        });
      }
    }, 0);
  }

  // ══ Tool: Dimension Line ═══════════════════════════════════════════════════

  function finishDimensionLine(p1, p2) {
    var distFt = turf.distance(turf.point(p1), turf.point(p2), { units: 'feet' });
    var az     = azimuthBetween(p1, p2);
    var lbl    = buildLabel(distFt, az);
    if (!lbl) lbl = formatDistShort(distFt);

    var mid = turf.midpoint(turf.point(p1), turf.point(p2)).geometry.coordinates;
    var rot = computeLabelRotation(p1, p2);

    _lastAnnotationIds = [];
    var lineId = addAnnotation({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: [p1, p2] },
      properties: {
        featureType: 'measure-dimension', label: null, labelAuto: false,
        style: { strokeColor:'#7c3aed', strokeWidth:2, strokeDash:'solid',
                 fillColor:'#7c3aed', fillOpacity:0,
                 fontSize:11, fontColor:'#5b21b6', arrowStart:true, arrowEnd:true },
      },
    });
    if (lineId) _lastAnnotationIds.push(lineId);
    var lblId = addLabelAnnotation(mid, lbl, 'measure-dimension', rot);
    if (lblId) _lastAnnotationIds.push(lblId);
  }

  // ══ Advanced: Bearing & Distance Query ═════════════════════════════════════

  function finishBearingDist(p1, p2) {
    var distFt = turf.distance(turf.point(p1), turf.point(p2), { units: 'feet' });
    var az     = azimuthBetween(p1, p2);
    var backAz = backBearing(az);
    var distMi = distFt / 5280;

    _bdHistory.unshift({
      bearing: azimuthToQuadrant(az),
      dist:    distFt,
    });
    if (_bdHistory.length > 5) _bdHistory.pop();

    var histHtml = '';
    if (_bdHistory.length > 1) {
      histHtml = '<details class="msr-history"><summary>Session History (' + _bdHistory.length + ')</summary><ul class="msr-hist-list">';
      _bdHistory.forEach(function (h, i) {
        histHtml += '<li>' + esc(h.bearing) + ' &mdash; ' + formatDistShort(h.dist) + '</li>';
      });
      histHtml += '</ul>' +
        '<button class="msr-btn msr-btn-sm" id="msr-clear-hist-btn">Clear History</button>' +
        '</details>';
    }

    // Auto-save immediately — no "Save to Map" button required
    _lastAnnotationIds = [];
    var lineId = addAnnotation({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: [p1, p2] },
      properties: {
        featureType: 'measure-bearing-distance', label: null, labelAuto: false,
        style: { strokeColor:'#0ea5e9', strokeWidth:2, strokeDash:'solid',
                 fillColor:'#0ea5e9', fillOpacity:0,
                 fontSize:11, fontColor:'#0369a1', arrowStart:false, arrowEnd:true },
      },
    });
    if (lineId) _lastAnnotationIds.push(lineId);
    var lbl = buildLabel(distFt, az);
    if (lbl) {
      var mid   = turf.midpoint(turf.point(p1), turf.point(p2)).geometry.coordinates;
      var rot   = computeLabelRotation(p1, p2);
      var lblId = addLabelAnnotation(mid, lbl, 'measure-bearing-distance', rot);
      if (lblId) _lastAnnotationIds.push(lblId);
    }

    var html = '<table class="msr-result-table">' +
      row('Bearing (Quadrant)',   azimuthToQuadrant(az)) +
      row('Bearing (Azimuth)',    (((az % 360) + 360) % 360).toFixed(3) + '°') +
      row('Back-Bearing',         azimuthToQuadrant(backAz)) +
      row('Distance',             formatDist(distFt)) +
      '</table>' + histHtml +
      '<div class="msr-hud-btn-row">' +
        '<button class="msr-btn msr-btn-danger" id="msr-clear-last-btn">Clear This Measurement</button>' +
      '</div>';

    showHud('🧭 Bearing &amp; Distance', html, null);

    setTimeout(function () {
      var clearBtn = document.getElementById('msr-clear-last-btn');
      if (clearBtn) clearBtn.addEventListener('click', clearLastMeasurement);
      var histBtn = document.getElementById('msr-clear-hist-btn');
      if (histBtn) histBtn.addEventListener('click', function () {
        _bdHistory = [];
        activateTool('bearing-dist');
      });
    }, 0);

    // Reset for next query
    _stepCount  = 0;
    _stepPoints = [];
    _drawCoords = [];
    clearPreview();
    if (window.PS_STATE) window.PS_STATE.activeDrawTool = 'measure';
  }

  // ══ Advanced: Perpendicular Distance ═══════════════════════════════════════

  function finishPerpendicular(lineA, lineB, point) {
    // Project point onto line AB
    var ax = lineA[0], ay = lineA[1];
    var bx = lineB[0], by = lineB[1];
    var px = point[0],  py = point[1];
    var abx = bx - ax, aby = by - ay;
    var apx = px - ax, apy = py - ay;
    var t   = (apx * abx + apy * aby) / (abx * abx + aby * aby);
    t = Math.max(0, Math.min(1, t));
    var footX = ax + t * abx;
    var footY = ay + t * aby;
    var foot  = [footX, footY];

    var perpFt = turf.distance(turf.point(point), turf.point(foot), { units: 'feet' });
    var lineFt = turf.distance(turf.point(lineA), turf.point(lineB), { units: 'feet' });

    // Auto-save immediately — no "Save to Map" button required
    _lastAnnotationIds = [];
    // Reference line (dashed)
    var refId = addAnnotation({ type: 'Feature',
      geometry: { type: 'LineString', coordinates: [lineA, lineB] },
      properties: { featureType: 'measure-perpendicular', label: null, labelAuto: false,
        style: { strokeColor:'#f59e0b', strokeWidth:2, strokeDash:'dashed',
                 fillColor:'#f59e0b', fillOpacity:0, fontSize:11, fontColor:'#92400e',
                 arrowStart:false, arrowEnd:false } } });
    if (refId) _lastAnnotationIds.push(refId);
    // Perpendicular drop line
    var perpLineId = addAnnotation({ type: 'Feature',
      geometry: { type: 'LineString', coordinates: [point, foot] },
      properties: { featureType: 'measure-perpendicular', label: null, labelAuto: false,
        style: { strokeColor:'#f59e0b', strokeWidth:2, strokeDash:'solid',
                 fillColor:'#f59e0b', fillOpacity:0, fontSize:11, fontColor:'#92400e',
                 arrowStart:false, arrowEnd:true } } });
    if (perpLineId) _lastAnnotationIds.push(perpLineId);
    // Midpoint label aligned to the perpendicular drop
    var mid    = turf.midpoint(turf.point(point), turf.point(foot)).geometry.coordinates;
    var lbl    = buildLabel(perpFt, undefined);
    var rot    = computeLabelRotation(point, foot);
    var lblId  = addLabelAnnotation(mid, lbl || formatDistShort(perpFt), 'measure-perpendicular', rot);
    if (lblId) _lastAnnotationIds.push(lblId);

    var html = '<table class="msr-result-table">' +
      row('Perpendicular Distance', formatDist(perpFt)) +
      row('Reference Line Length',  formatDistShort(lineFt)) +
      '</table>' +
      '<div class="msr-hud-btn-row">' +
        '<button class="msr-btn msr-btn-danger" id="msr-clear-last-btn">Clear This Measurement</button>' +
      '</div>';

    showHud('📏 Perpendicular', html, null);
    setTimeout(function () {
      var btn = document.getElementById('msr-clear-last-btn');
      if (btn) btn.addEventListener('click', clearLastMeasurement);
    }, 0);

    _stepCount  = 0;
    _stepPoints = [];
    _drawCoords = [];
    clearPreview();
    if (window.PS_STATE) window.PS_STATE.activeDrawTool = 'measure';
  }

  // ══ Advanced: Arc / Radius ══════════════════════════════════════════════════

  function fitCircleThreePoints(p1, p2, p3) {
    // Work in local meters centered on p2 to minimise floating-point error
    var lat2 = p2[1] * Math.PI / 180;
    var metersPerDegLng = Math.cos(lat2) * 111320;
    var metersPerDegLat = 110540;

    function toLocal(p) {
      return [(p[0] - p2[0]) * metersPerDegLng,
              (p[1] - p2[1]) * metersPerDegLat];
    }

    var l1 = toLocal(p1), l2 = [0, 0], l3 = toLocal(p3);
    var ax = l1[0] - l3[0], ay = l1[1] - l3[1];
    var bx = l2[0] - l3[0], by = l2[1] - l3[1];
    var D  = 2 * (ax * (l2[1] - l3[1]) - ay * (l2[0] - l3[0]));
    if (Math.abs(D) < 1e-10) return null; // collinear

    var ux = ((ax * (l1[0] + l3[0]) + ay * (l1[1] + l3[1])) * (l2[1] - l3[1]) -
              (bx * (l2[0] + l3[0]) + by * (l2[1] + l3[1])) * (l1[1] - l3[1])) / D;
    var uy = ((bx * (l2[0] + l3[0]) + by * (l2[1] + l3[1])) * (l1[0] - l3[0]) -
              (ax * (l1[0] + l3[0]) + ay * (l1[1] + l3[1])) * (l2[0] - l3[0])) / D;

    var radiusM  = Math.sqrt((l1[0] - ux) * (l1[0] - ux) + (l1[1] - uy) * (l1[1] - uy));
    var radiusFt = radiusM * FEET_PER_METER;

    // Angles from center to p1 and p3
    var a1 = Math.atan2(l1[1] - uy, l1[0] - ux);
    var a3 = Math.atan2(l3[1] - uy, l3[0] - ux);
    var ap = Math.atan2(0 - uy, 0 - ux);   // angle to p2

    // Delta: always the arc that passes through p2
    var delta = a3 - a1;
    // Normalise to see which direction the arc through p2 goes
    var cross = (l1[0] - l3[0]) * (ap - l1[1]) - (l1[1] - l3[1]) * (ap - l1[0]);
    var ccw = cross > 0;
    if (ccw && delta < 0) delta += 2 * Math.PI;
    if (!ccw && delta > 0) delta -= 2 * Math.PI;
    if (delta < 0) delta = -delta;

    var arcLengthFt    = radiusFt * delta;
    var chordFt        = turf.distance(turf.point(p1), turf.point(p3), { units: 'feet' });
    var chordAz        = azimuthBetween(p1, p3);
    var tangentFt      = radiusFt * Math.tan(delta / 2);
    var deltaDegs      = delta * 180 / Math.PI;

    return {
      radiusFt: radiusFt, deltaDegs: deltaDegs,
      arcLengthFt: arcLengthFt, chordFt: chordFt,
      chordAz: chordAz, tangentFt: tangentFt,
      direction: ccw ? 'Left (Counter-Clockwise)' : 'Right (Clockwise)',
    };
  }

  function finishArc(p1, p2, p3) {
    var result = fitCircleThreePoints(p1, p2, p3);
    if (!result) {
      showHud('🔄 Arc / Radius',
        '<div class="msr-hud-hint msr-hud-error">The three points are collinear — cannot fit a curve. Try a different middle point.</div>',
        null);
      _stepCount = 0; _stepPoints = []; _drawCoords = [];
      return;
    }

    function fmtDelta(d) {
      var deg = Math.floor(d);
      var mf  = (d - deg) * 60;
      var min = Math.floor(mf);
      var sec = Math.round((mf - min) * 60);
      return deg + '°' + pad2(min) + '′' + pad2(sec) + '″';
    }

    var html = '<table class="msr-result-table">' +
      row('Radius',          formatDistShort(result.radiusFt)) +
      row('Delta Angle',     fmtDelta(result.deltaDegs)) +
      row('Arc Length',      formatDistShort(result.arcLengthFt)) +
      row('Chord Length',    formatDistShort(result.chordFt)) +
      row('Chord Bearing',   azimuthToQuadrant(result.chordAz)) +
      row('Tangent Length',  formatDistShort(result.tangentFt)) +
      row('Curve Direction', result.direction) +
      '</table>';

    var pts = [p1, p2, p3];
    showHud('🔄 Arc / Radius', html, function () {
      // Draw arc as 64-point polyline
      try {
        var arcCoords = [];
        for (var i = 0; i <= 64; i++) {
          var t = i / 64;
          var midPt = [
            pts[0][0] + t * (pts[2][0] - pts[0][0]),
            pts[0][1] + t * (pts[2][1] - pts[0][1]),
          ];
          arcCoords.push(midPt);
        }
        // Use turf.bezierSpline to approximate arc through three points
        var lineFC = turf.lineString([pts[0], pts[1], pts[2]]);
        var spline = turf.bezierSpline(lineFC, { resolution: 10000, sharpness: 0.9 });
        addAnnotation({ type: 'Feature',
          geometry: spline.geometry,
          properties: { featureType: 'measure-arc', label: null, labelAuto: false,
            style: { strokeColor:'#db2777', strokeWidth:2, strokeDash:'solid',
                     fillColor:'#db2777', fillOpacity:0, fontSize:11, fontColor:'#9d174d',
                     arrowStart:false, arrowEnd:false } } });
        // Chord (dashed)
        addAnnotation({ type: 'Feature',
          geometry: { type: 'LineString', coordinates: [pts[0], pts[2]] },
          properties: { featureType: 'measure-arc', label: null, labelAuto: false,
            style: { strokeColor:'#db2777', strokeWidth:1, strokeDash:'dashed',
                     fillColor:'#db2777', fillOpacity:0, fontSize:11, fontColor:'#9d174d',
                     arrowStart:false, arrowEnd:false } } });
        // Arc midpoint label
        var lbl = 'R=' + formatDistShort(result.radiusFt) + '\nΔ=' + fmtDelta(result.deltaDegs);
        addLabelAnnotation(pts[1], lbl, 'measure-arc');
      } catch (ex) { /* skip if bezier fails */ }
    });

    _stepCount = 0; _stepPoints = []; _drawCoords = [];
    clearPreview();
    if (window.PS_STATE) window.PS_STATE.activeDrawTool = 'measure';
  }

  // ══ Advanced: Running / Cumulative Dimension ════════════════════════════════

  function finishRunningDim() {
    if (_drawCoords.length < 2) { deactivateTool(); return; }
    var coords = _drawCoords.slice();

    // Auto-save all annotations immediately; track IDs for "Clear This Measurement"
    _lastAnnotationIds = [];
    var lineId = addAnnotation({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: coords },
      properties: { featureType: 'measure-running', label: null, labelAuto: false,
        style: { strokeColor:'#7c3aed', strokeWidth:2, strokeDash:'solid',
                 fillColor:'#7c3aed', fillOpacity:0, fontSize:11,
                 fontColor:'#5b21b6', arrowStart:false, arrowEnd:false } },
    });
    if (lineId) _lastAnnotationIds.push(lineId);

    var cumFt = 0;
    for (var i = 1; i < coords.length; i++) {
      var segFt = turf.distance(turf.point(coords[i-1]), turf.point(coords[i]), { units: 'feet' });
      cumFt += segFt;
      var az    = azimuthBetween(coords[i-1], coords[i]);
      var mid   = turf.midpoint(turf.point(coords[i-1]), turf.point(coords[i])).geometry.coordinates;
      var lbl   = formatDistShort(segFt) + '\n(total: ' + formatDistShort(cumFt) + ')';
      if (_settings.annotateBearing) lbl = formatBearing(az) + '\n' + lbl;
      // computeLabelRotation stores rotation inside style so annotation-store keeps it
      var rot   = computeLabelRotation(coords[i-1], coords[i]);
      var lblId = addLabelAnnotation(mid, lbl, 'measure-running', rot);
      if (lblId) _lastAnnotationIds.push(lblId);
    }
    // Grand total at endpoint (no rotation — horizontal by default)
    var totId = addLabelAnnotation(coords[coords.length - 1],
      'TOTAL: ' + formatDistShort(cumFt), 'measure-running');
    if (totId) _lastAnnotationIds.push(totId);

    var html =
      '<div class="msr-hud-hint">Running dimension placed — <strong>' +
        formatDistShort(cumFt) + '</strong> total.</div>' +
      '<div class="msr-hud-btn-row">' +
        '<button class="msr-btn msr-btn-danger" id="msr-clear-last-btn">Clear This Measurement</button>' +
      '</div>';

    showHud('📏 Running Dimension', html, null);
    setTimeout(function () {
      var btn = document.getElementById('msr-clear-last-btn');
      if (btn) btn.addEventListener('click', clearLastMeasurement);
    }, 0);

    _drawCoords = [];
    clearPreview();
  }

  // ══ Advanced: Angle Annotation ══════════════════════════════════════════════

  function finishAngle(vertex, rayEnd1, rayEnd2) {
    var az1 = azimuthBetween(vertex, rayEnd1);
    var az2 = azimuthBetween(vertex, rayEnd2);
    var ang = Math.abs(az2 - az1);
    if (ang > 180) ang = 360 - ang;

    var deg = Math.floor(ang);
    var mf  = (ang - deg) * 60;
    var min = Math.floor(mf);
    var sec = Math.round((mf - min) * 60);
    var lbl = deg + '°' + pad2(min) + '\'' + pad2(sec) + '"';

    var midAz = (az1 + az2) / 2;
    var arcPt = turf.destination(turf.point(vertex),
      turf.distance(turf.point(vertex), turf.point(rayEnd1), { units: 'feet' }) * 0.4 / FEET_PER_METER / 1000,
      midAz, { units: 'kilometers' }).geometry.coordinates;

    addAnnotation({ type: 'Feature',
      geometry: { type: 'LineString', coordinates: [rayEnd1, vertex, rayEnd2] },
      properties: { featureType: 'measure-angle', label: null, labelAuto: false,
        style: { strokeColor:'#ea580c', strokeWidth:2, strokeDash:'solid',
                 fillColor:'#ea580c', fillOpacity:0, fontSize:11,
                 fontColor:'#7c2d12', arrowStart:false, arrowEnd:false } } });
    addLabelAnnotation(arcPt, lbl, 'measure-angle');

    _stepCount = 0; _stepPoints = []; _drawCoords = [];
    clearPreview();
    if (window.PS_STATE) window.PS_STATE.activeDrawTool = 'measure';
  }

  // ══ Advanced: Auto-Dimension Parcel (with inline boundary analysis) ═════════

  /** Extract outer-ring segments from a parcel feature. */
  function getParcelSegments(feature) {
    var segs = [];
    if (!feature || !feature.geometry) return segs;
    var geom = feature.geometry;
    var rings = [];
    if (geom.type === 'Polygon') {
      rings.push(geom.coordinates[0]);
    } else if (geom.type === 'MultiPolygon') {
      geom.coordinates.forEach(function (p) { rings.push(p[0]); });
    }
    rings.forEach(function (ring) {
      for (var i = 0; i < ring.length - 1; i++) {
        var start = ring[i].slice();
        var end   = ring[i + 1].slice();
        var mid   = turf.midpoint(turf.point(start), turf.point(end)).geometry.coordinates;
        var az    = azimuthBetween(start, end);
        var ft    = turf.distance(turf.point(start), turf.point(end), { units: 'feet' });
        segs.push({ start: start, end: end, midpoint: mid, azimuth: az, lengthFt: ft });
      }
    });
    return segs;
  }

  /** Bearing difference (0–180) between two azimuths. */
  function bearingDiff(a, b) {
    var d = Math.abs(a - b) % 360;
    return d > 180 ? 360 - d : d;
  }

  /** Merge segments whose bearings differ by less than threshold (collinear). */
  function mergeCollinearSegments(segs, threshDeg) {
    if (segs.length === 0) return [];
    var merged = [];
    var cur    = segs[0];
    for (var i = 1; i < segs.length; i++) {
      var diff = bearingDiff(cur.azimuth, segs[i].azimuth);
      if (diff <= threshDeg) {
        // Merge: extend current segment to the far end
        var newEnd  = segs[i].end;
        var newFt   = cur.lengthFt + segs[i].lengthFt;
        var newMid  = turf.midpoint(turf.point(cur.start), turf.point(newEnd)).geometry.coordinates;
        var newAz   = azimuthBetween(cur.start, newEnd);
        cur = { start: cur.start, end: newEnd, midpoint: newMid, azimuth: newAz, lengthFt: newFt };
      } else {
        merged.push(cur);
        cur = segs[i];
      }
    }
    merged.push(cur);
    return merged;
  }

  /** Read auto-dim options from the panel DOM. */
  function readAutoDimOptions() {
    function val(id, def) {
      var el = document.getElementById(id);
      return el ? el.value : def;
    }
    function chk(id, def) {
      var el = document.getElementById(id);
      return el ? el.checked : def;
    }
    return {
      labelContent:     val('msr-ad-label-content', 'both'),
      labelPosition:    val('msr-ad-label-pos',     'outside'),
      minSegFt:         parseFloat(val('msr-ad-min-seg', String(DEFAULT_MIN_SEGMENT_FT))) || DEFAULT_MIN_SEGMENT_FT,
      collinearityDeg:  parseFloat(val('msr-ad-collinear', String(COLLINEARITY_THRESHOLD_DEG))) || COLLINEARITY_THRESHOLD_DEG,
      groupName:        val('msr-ad-group', '{PIN} Dimensions').trim(),
      detectArcs:       chk('msr-ad-arcs', true),
    };
  }

  /**
   * Tweak 6: Partition merged segments into three bucket types:
   *   'normal'     — long enough to label individually
   *   'chord'      — run of 2+ consecutive short segments; label with "~" prefix
   *   'suppressed' — single isolated short segment; no annotation
   */
  function partitionSegments(segs, minFt) {
    var result = [];
    var run    = [];   // current run of short segments

    function flushRun() {
      if (run.length === 0) return;
      if (run.length === 1) {
        result.push({ type: 'suppressed', seg: run[0] });
      } else {
        var cs   = run[0].start;
        var ce   = run[run.length - 1].end;
        var cFt  = turf.distance(turf.point(cs), turf.point(ce), { units: 'feet' });
        var cMid = turf.midpoint(turf.point(cs), turf.point(ce)).geometry.coordinates;
        result.push({ type: 'chord',
          start: cs, end: ce, midpoint: cMid,
          azimuth: azimuthBetween(cs, ce), lengthFt: cFt });
      }
      run = [];
    }

    segs.forEach(function (s) {
      if (s.lengthFt >= minFt) { flushRun(); result.push({ type: 'normal', seg: s }); }
      else                     { run.push(s); }
    });
    flushRun();
    return result;
  }

  function runAutoDim(parcel) {
    var opts   = readAutoDimOptions();
    var props  = parcel.properties || {};
    var pin    = props.pin || props.PIN || 'Parcel';
    var grpName = opts.groupName.replace('{PIN}', pin);

    var rawSegs   = getParcelSegments(parcel);
    var segs      = mergeCollinearSegments(rawSegs, opts.collinearityDeg);
    // Tweak 6: partition into normal / chord-run / suppressed buckets
    var partitions = partitionSegments(segs, opts.minSegFt);
    var suppressed = partitions.filter(function (p) { return p.type === 'suppressed'; }).length;

    // Check for existing group
    var store = getStore();
    if (store) {
      var groups = store.getState().layerGroups;
      if (groups.indexOf(grpName) !== -1) {
        var existing = store.getAnnotationsByGroup(grpName);
        if (existing && existing.length > 0) {
          if (!confirm('Replace existing dimensions for "' + grpName + '"?\nOK = Replace  ·  Cancel = Keep Both')) {
            // Keep both — use a unique name
            grpName = grpName + ' (' + new Date().toLocaleTimeString() + ')';
          } else {
            // Delete existing group annotations
            var ids = existing.map(function (f) { return f.id; });
            store.deleteAnnotations(ids);
          }
        }
      }
      store.addLayerGroup(grpName);
      store.setActiveLayerGroup(grpName);
    }

    var labeled = 0;

    // Tweak 2 fix: compute centroid once for inside/outside direction logic
    var parcelCentroid = turf.centroid(parcel).geometry.coordinates;

    // Tweak 6: annotate normal segments and chord groups; skip isolated suppressed ones
    function annotateSeg(segData, isChord) {
      var az  = segData.azimuth;
      var ft  = segData.lengthFt;
      var lbl = '';
      if (opts.labelContent === 'distance' || opts.labelContent === 'both') {
        lbl += (isChord ? '~' : '') + formatDistShort(ft);
      }
      if (opts.labelContent === 'bearing' || opts.labelContent === 'both') {
        lbl = (lbl ? azimuthToQuadrant(az) + '\n' + lbl : azimuthToQuadrant(az));
      }

      // Tweak 2 fix: use centroid bearing to determine true inside/outside direction.
      // (az ± 90 gives a perpendicular but doesn't know which side is "inside" the parcel.)
      var toBearingCentroid = turf.bearing(turf.point(segData.midpoint), turf.point(parcelCentroid));
      var awayBearing = ((toBearingCentroid + 180) % 360 + 360) % 360;
      var perpAz = opts.labelPosition === 'outside' ? awayBearing :
                   opts.labelPosition === 'inside'  ? toBearingCentroid : az;

      var offsetKm = toMeters(20) / 1000;
      var anchor   = turf.destination(
        turf.point(segData.midpoint), offsetKm, perpAz, { units: 'kilometers' }
      ).geometry.coordinates;

      var rot = computeLabelRotation(segData.start, segData.end);

      addAnnotation({ type: 'Feature',
        geometry: { type: 'LineString', coordinates: [segData.start, segData.end] },
        properties: { featureType: 'measure-parcel-dim', label: null, labelAuto: false,
          style: { strokeColor: isChord ? '#6b7280' : '#374151',
                   strokeWidth: isChord ? 1 : 1.5,
                   strokeDash: isChord ? 'dashed' : 'solid',
                   fillColor:'#374151', fillOpacity:0, fontSize:11,
                   fontColor:'#1f2937', arrowStart:!isChord, arrowEnd:!isChord } } });
      addLabelAnnotation(anchor, lbl, 'measure-parcel-dim', rot);
      labeled++;
    }

    partitions.forEach(function (p) {
      if (p.type === 'normal')      annotateSeg(p.seg, false);
      else if (p.type === 'chord')  annotateSeg(p,     true);
      // 'suppressed' → no annotation
    });

    // Tweak 7: area label at parcel centroid (reuse parcelCentroid computed above)
    var areaM2  = turf.area(parcel);
    var acres   = areaM2 / SQ_M_PER_ACRE;
    try {
      var areaStr = acres >= 1
        ? acres.toFixed(2) + ' ac'
        : Math.round(areaM2 / SQ_M_PER_SQ_FT).toLocaleString() + ' sf';
      addLabelAnnotation(parcelCentroid, areaStr, 'measure-dimension-area');
      labeled++;
    } catch (_) {}

    // Result HUD
    var totalFt = rawSegs.reduce(function (a, s) { return a + s.lengthFt; }, 0);

    var html = '<table class="msr-result-table">' +
      row('Parcel',            esc(pin)) +
      row('Segments labeled',  String(labeled)) +
      row('Segments suppressed', String(suppressed) + ' (below ' + opts.minSegFt + ' ft)') +
      row('Perimeter',         formatDistShort(totalFt)) +
      row('Area',              acres.toFixed(2) + ' acres') +
      row('Group',             esc(grpName)) +
      '</table>' +
      '<div class="msr-hud-btn-row">' +
        '<button class="msr-btn" id="msr-dim-another-btn">Dimension Another</button>' +
        '<button class="msr-btn msr-btn-danger" id="msr-clear-dim-btn">Clear This Group</button>' +
      '</div>';

    showHud('⬡ Dimension Parcel', html, null);

    setTimeout(function () {
      var anotherBtn = document.getElementById('msr-dim-another-btn');
      var clearBtn   = document.getElementById('msr-clear-dim-btn');
      if (anotherBtn) anotherBtn.addEventListener('click', function () {
        activateTool('auto-dim');
      });
      if (clearBtn) clearBtn.addEventListener('click', function () {
        var st = getStore();
        if (st) {
          var existing = st.getAnnotationsByGroup(grpName);
          if (existing && existing.length > 0) {
            st.deleteAnnotations(existing.map(function (f) { return f.id; }));
            st.removeLayerGroup(grpName);
          }
        }
        hideHud();
        activateTool('auto-dim');
      });
    }, 0);

    _stepCount = 0; _stepPoints = []; _drawCoords = [];
    clearPreview();
    if (window.PS_STATE) window.PS_STATE.activeDrawTool = 'measure';
  }

  // ══ Annotation helpers ════════════════════════════════════════════════════

  /**
   * Add an annotation to the store and return its assigned ID.
   * If _tempMode is active the tool is also deactivated.
   * @returns {string|null} the new annotation's ID, or null if store unavailable
   */
  function addAnnotation(feature) {
    var store = getStore();
    if (!store) return null;
    var id = store.addAnnotation(feature);
    if (_tempMode) deactivateTool();
    return id || null;
  }

  /**
   * Add a Point label annotation, storing labelRotation inside the style object
   * (annotation-store strips top-level custom properties but deep-merges style).
   * @param {[number,number]} lngLat
   * @param {string}          text
   * @param {string}          [featureType]
   * @param {number}          [labelRotation]  MapLibre rotation in degrees; 0 if omitted
   * @returns {string|null} the new annotation's ID
   */
  function addLabelAnnotation(lngLat, text, featureType, labelRotation) {
    var store = getStore();
    if (!store) return null;
    return store.addAnnotation({ type: 'Feature',
      geometry: { type: 'Point', coordinates: lngLat },
      properties: {
        featureType: featureType || 'measure-label',
        label:       text,
        labelAuto:   false,
        style: {
          strokeColor:'#374151', strokeWidth:1, strokeDash:'solid',
          fillColor:'#374151',   fillOpacity:0,
          fontSize:11,           fontColor:'#1f2937',
          arrowStart:false,      arrowEnd:false,
          labelRotation: typeof labelRotation === 'number' ? labelRotation : 0,
        },
      },
    }) || null;
  }

  /**
   * Delete the annotations created by the most recent finish call.
   * Wired to every "Clear This Measurement" button.
   */
  function clearLastMeasurement() {
    if (_lastAnnotationIds.length === 0) return;
    var store = getStore();
    if (store) store.deleteAnnotations(_lastAnnotationIds.slice());
    _lastAnnotationIds = [];
  }

  function row(label, value) {
    return '<tr><td class="msr-result-lbl">' + esc(label) + '</td><td class="msr-result-val">' + value + '</td></tr>';
  }

  function esc(str) {
    return String(str || '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // ══ Map event handlers ════════════════════════════════════════════════════

  function onMsrMouseMove(e) {
    if (!_activeTool) return;
    var snapped = snapLngLat(e.lngLat);

    switch (_activeTool) {
      case 'measure-area':
        if (_drawCoords.length > 0) updateAreaPreview();
        break;
      case 'measure-dist':
      case 'running-dim':
        if (_drawCoords.length > 0) updateDistPreview(snapped);
        break;
      case 'dimension-line':
      case 'bearing-dist':
        if (_stepCount === 1 && _stepPoints.length === 1) {
          setPreview({ type: 'FeatureCollection', features: [{
            type: 'Feature',
            geometry: { type: 'LineString', coordinates: [_stepPoints[0], snapped] },
            properties: {} }] });
        }
        break;
      case 'perpendicular':
        if (_stepCount === 2 && _stepPoints.length === 2) {
          // Tweak 4: compute perpendicular foot live and update preview + HUD in real time
          var pA = _stepPoints[0], pB = _stepPoints[1], pC = snapped;
          var abx2 = pB[0] - pA[0], aby2 = pB[1] - pA[1];
          var apx2 = pC[0] - pA[0], apy2 = pC[1] - pA[1];
          var denom = abx2 * abx2 + aby2 * aby2;
          var tPerp = denom > 1e-20 ? (apx2 * abx2 + apy2 * aby2) / denom : 0;
          tPerp = Math.max(0, Math.min(1, tPerp));
          var footLive = [pA[0] + tPerp * abx2, pA[1] + tPerp * aby2];
          var perpFtLive = turf.distance(turf.point(pC), turf.point(footLive), { units: 'feet' });
          showHud('📐 Perpendicular',
            '<div class="msr-hud-hint">Click to confirm &mdash; ' +
              '<strong>' + formatDistShort(perpFtLive) + '</strong></div>', null);
          setPreview({ type: 'FeatureCollection', features: [
            { type: 'Feature',
              geometry: { type: 'LineString', coordinates: [pA, pB] },
              properties: {} },
            { type: 'Feature',
              geometry: { type: 'LineString', coordinates: [pC, footLive] },
              properties: {} },
            { type: 'Feature',
              geometry: { type: 'Point', coordinates: footLive },
              properties: { role: 'vertex', label: null } },
          ] });
        } else if (_stepCount === 1 && _stepPoints.length === 1) {
          setPreview({ type: 'FeatureCollection', features: [{
            type: 'Feature',
            geometry: { type: 'LineString', coordinates: [_stepPoints[0], snapped] },
            properties: {} }] });
        }
        break;
      case 'arc-radius':
      case 'angle':
        if (_stepPoints.length > 0) {
          var coords = _stepPoints.concat([snapped]);
          setPreview({ type: 'FeatureCollection', features: [{
            type: 'Feature',
            geometry: { type: 'LineString', coordinates: coords },
            properties: {} }] });
        }
        break;
    }
  }

  function onMsrClick(e) {
    if (!_activeTool) return;

    var snapped = snapLngLat(e.lngLat);

    switch (_activeTool) {
      case 'auto-dim':
        var pFeatures = getMap() ? getMap().queryRenderedFeatures(e.point, { layers: ['parcels-fill'] }) : [];
        if (pFeatures && pFeatures.length > 0) {
          // Need full geometry from index for accurate area
          var clickedPin = (pFeatures[0].properties || {}).pin || (pFeatures[0].properties || {}).PIN;
          var fullParcel = null;
          if (window.PS_PARCEL_INDEX && clickedPin) {
            for (var pi = 0; pi < window.PS_PARCEL_INDEX.length; pi++) {
              var pf = window.PS_PARCEL_INDEX[pi];
              var pfPin = (pf.properties || {}).pin || (pf.properties || {}).PIN;
              if (pfPin === clickedPin) { fullParcel = pf; break; }
            }
          }
          runAutoDim(fullParcel || pFeatures[0]);
        } else {
          showHud('⬡ Dimension Parcel',
            '<div class="msr-hud-hint msr-hud-error">No parcel found at this location. Click inside a parcel.</div>', null);
        }
        break;

      case 'coordinates':
        handleCoordinatesClick(snapped);
        break;

      case 'measure-area':
        // Finish is ONLY via Enter key (3+ vertices required).
        _drawCoords.push(snapped);
        if (_drawCoords.length === 1) {
          // Starting a new polygon — refresh hint with running count
          showHud('□ Measure Area',
            '<div class="msr-hud-hint">1 vertex. Keep clicking, then press Enter to finish.</div>', null);
        } else {
          showHud('□ Measure Area',
            '<div class="msr-hud-hint">' + _drawCoords.length + ' vertices. Press Enter to finish' +
            (_drawCoords.length < 3 ? ' (need ' + (3 - _drawCoords.length) + ' more)' : '') + '.</div>', null);
        }
        updateAreaPreview();
        break;

      case 'measure-dist':
        // Finish is ONLY via Enter key (2+ points required).
        _drawCoords.push(snapped);
        if (_drawCoords.length === 1) {
          showHud('📏 Measure Distance',
            '<div class="msr-hud-hint">1 point. Click more waypoints, then press Enter to finish.</div>', null);
        } else {
          showHud('📏 Measure Distance',
            '<div class="msr-hud-hint">' + _drawCoords.length + ' points. Press Enter to finish.</div>', null);
        }
        updateDistPreview();
        break;

      case 'running-dim':
        // Finish is ONLY via Enter key (2+ points required).
        _drawCoords.push(snapped);
        if (_drawCoords.length === 1) {
          showHud('📏 Running Dimension',
            '<div class="msr-hud-hint">1 point. Click more waypoints, then press Enter to finish.</div>', null);
        } else {
          showHud('📏 Running Dimension',
            '<div class="msr-hud-hint">' + _drawCoords.length + ' points. Press Enter to finish.</div>', null);
        }
        updateDistPreview();
        break;

      case 'dimension-line':
        _stepPoints.push(snapped);
        _stepCount++;
        if (_stepCount === 1) {
          showHud('↔️ Dimension Line',
            '<div class="msr-hud-hint">Click end point.</div>', null);
        } else if (_stepCount === 2) {
          finishDimensionLine(_stepPoints[0], _stepPoints[1]);
          _stepCount = 0; _stepPoints = [];
          clearPreview();
          // Stay in tool
          if (window.PS_STATE) window.PS_STATE.activeDrawTool = 'measure';
          showHud('↔️ Dimension Line',
            '<div class="msr-hud-hint">Click start point for another dimension.</div>' +
            '<div class="msr-hud-btn-row">' +
              '<button class="msr-btn msr-btn-danger" id="msr-clear-last-btn">Clear This Measurement</button>' +
            '</div>', null);
          setTimeout(function () {
            var btn = document.getElementById('msr-clear-last-btn');
            if (btn) btn.addEventListener('click', clearLastMeasurement);
          }, 0);
        }
        break;

      case 'bearing-dist':
        _stepPoints.push(snapped);
        _stepCount++;
        if (_stepCount === 1) {
          showHud('🧭 Bearing &amp; Distance',
            '<div class="msr-hud-hint">Click end point.</div>', null);
        } else if (_stepCount === 2) {
          finishBearingDist(_stepPoints[0], _stepPoints[1]);
        }
        break;

      case 'perpendicular':
        _stepPoints.push(snapped);
        _stepCount++;
        if (_stepCount === 1) {
          showHud('📏 Perpendicular',
            '<div class="msr-hud-hint">Click line end point.</div>', null);
        } else if (_stepCount === 2) {
          showHud('📏 Perpendicular',
            '<div class="msr-hud-hint">Click the point to measure from.</div>', null);
        } else if (_stepCount === 3) {
          finishPerpendicular(_stepPoints[0], _stepPoints[1], _stepPoints[2]);
        }
        break;

      case 'arc-radius':
        _stepPoints.push(snapped);
        _stepCount++;
        if (_stepCount === 1) showHud('🔄 Arc / Radius', '<div class="msr-hud-hint">Click midpoint of arc.</div>', null);
        else if (_stepCount === 2) showHud('🔄 Arc / Radius', '<div class="msr-hud-hint">Click end point of arc.</div>', null);
        else if (_stepCount === 3) finishArc(_stepPoints[0], _stepPoints[1], _stepPoints[2]);
        break;

      case 'angle':
        // Tweak 5: order is ray1End(0) → vertex(1) → ray2End(2)
        _stepPoints.push(snapped);
        _stepCount++;
        if      (_stepCount === 1) showHud('📐 Angle', '<div class="msr-hud-hint">Click vertex (corner point).</div>', null);
        else if (_stepCount === 2) showHud('📐 Angle', '<div class="msr-hud-hint">Click second ray endpoint.</div>', null);
        else if (_stepCount === 3) finishAngle(_stepPoints[1], _stepPoints[0], _stepPoints[2]);
        //                                     ↑ vertex          ↑ ray1End       ↑ ray2End
        break;
    }
  }

  function onMsrKeyDown(e) {
    if (!_activeTool) return;
    // Never intercept keys when focus is inside a form element
    var tag = e.target && e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

    if (e.key === 'Escape') {
      deactivateTool();
      return;
    }

    if (e.key === 'Enter') {
      if (_activeTool === 'measure-area') {
        if (_drawCoords.length >= 3) {
          finishMeasureArea();
        } else {
          showHud('□ Measure Area',
            '<div class="msr-hud-hint msr-hud-error">Need at least 3 vertices (' +
              _drawCoords.length + ' placed so far). Keep clicking to add more.</div>', null);
        }
        return;
      }
      if (_activeTool === 'measure-dist') {
        if (_drawCoords.length >= 2) {
          finishMeasureDistance();
        } else {
          showHud('📏 Measure Distance',
            '<div class="msr-hud-hint msr-hud-error">Need at least 2 points (' +
              _drawCoords.length + ' placed so far). Keep clicking to add more.</div>', null);
        }
        return;
      }
      if (_activeTool === 'running-dim') {
        if (_drawCoords.length >= 2) {
          finishRunningDim();
        } else {
          showHud('📏 Running Dimension',
            '<div class="msr-hud-hint msr-hud-error">Need at least 2 points (' +
              _drawCoords.length + ' placed so far). Keep clicking to add more.</div>', null);
        }
        return;
      }
    }
  }

  // ══ Wire map events (called once when map is ready) ════════════════════════

  function wireMapEvents() {
    if (_mapEventsWired) return;
    var map = getMap();
    if (!map) return;
    _mapEventsWired = true;
    map.on('mousemove', onMsrMouseMove);
    map.on('click',     onMsrClick);
  }

  function unwireMapEvents() {
    var map = getMap();
    if (!map) return;
    map.off('mousemove', onMsrMouseMove);
    map.off('click',     onMsrClick);
    _mapEventsWired = false;
  }

  // ══ Tool button state ══════════════════════════════════════════════════════

  var TOOL_BUTTON_MAP = {
    // Tweak 1: parcel-info tool removed
    'measure-area':  'msr-tool-area',
    'measure-dist':  'msr-tool-dist',
    'coordinates':   'msr-tool-coords',
    'dimension-line':'msr-tool-dimline',
    'bearing-dist':  'msr-tool-bearing',
    'perpendicular': 'msr-tool-perp',
    'arc-radius':    'msr-tool-arc',
    'running-dim':   'msr-tool-running',
    'angle':         'msr-tool-angle',
    'auto-dim':      'msr-tool-autodim',
  };

  function updateToolButtons() {
    Object.keys(TOOL_BUTTON_MAP).forEach(function (tool) {
      var btn = document.getElementById(TOOL_BUTTON_MAP[tool]);
      if (btn) btn.classList.toggle('active', tool === _activeTool);
    });
    // Show / hide the auto-dim options panel alongside the tool state
    renderAutoDimOptions();
  }

  // ══ Settings UI sync ══════════════════════════════════════════════════════

  function updateSettingsUI() {
    function setChk(id, val) {
      var el = document.getElementById(id);
      if (el) el.checked = val;
    }
    function setActive(groupSel, activeVal) {
      var parent = document.querySelector(groupSel);
      if (!parent) return;
      parent.querySelectorAll('[data-value]').forEach(function (btn) {
        btn.classList.toggle('active', btn.dataset.value === activeVal);
      });
    }
    setChk('msr-ann-dist', _settings.annotateDistance);
    setChk('msr-ann-bearing', _settings.annotateBearing);
    setActive('.msr-bearing-fmt-grp', _settings.bearingFormat);
    setActive('.msr-units-grp',       _settings.units);
  }

  // ══ Advanced section ══════════════════════════════════════════════════════

  function updateAdvancedToggle() {
    var btn  = document.getElementById('msr-adv-toggle');
    var body = document.getElementById('msr-advanced-body');
    if (!btn || !body) return;
    btn.textContent = (_advancedExpanded ? '▼' : '▶') + ' Advanced Tools';
    body.hidden     = !_advancedExpanded;
  }

  // ══ Panel event wiring ════════════════════════════════════════════════════

  function wirePanelEvents() {
    if (_eventsWired) return;
    _eventsWired = true;

    function wire(id, ev, fn) {
      var el = document.getElementById(id);
      if (el) el.addEventListener(ev, fn);
    }

    function toolBtn(id, toolName) {
      wire(id, 'click', function () {
        if (_activeTool === toolName) deactivateTool();
        else activateTool(toolName);
      });
    }

    // ── Basic tools (Tweak 1: parcel-info removed)
    toolBtn('msr-tool-area',        'measure-area');
    toolBtn('msr-tool-dist',        'measure-dist');
    toolBtn('msr-tool-coords',      'coordinates');
    toolBtn('msr-tool-dimline',     'dimension-line');

    // ── Advanced tools
    toolBtn('msr-tool-bearing',  'bearing-dist');
    toolBtn('msr-tool-perp',     'perpendicular');
    toolBtn('msr-tool-arc',      'arc-radius');
    toolBtn('msr-tool-running',  'running-dim');
    toolBtn('msr-tool-angle',    'angle');
    toolBtn('msr-tool-autodim',  'auto-dim');

    // Offset line stub
    wire('msr-tool-offset', 'click', function () {
      alert('Offset Line is coming in a future update.');
    });

    // Legal match stub (already greyed out, but guard click)
    wire('msr-tool-legal', 'click', function () {
      alert('Legal Description Match requires Phase M3 — coming soon.');
    });

    // ── Advanced toggle
    wire('msr-adv-toggle', 'click', function () {
      _advancedExpanded = !_advancedExpanded;
      saveAdvancedPref();
      updateAdvancedToggle();
    });

    // ── Settings — Annotate With checkboxes
    wire('msr-ann-dist', 'change', function () {
      _settings.annotateDistance = this.checked;
      saveSettings();
      updateHudSaveState();
    });
    wire('msr-ann-bearing', 'change', function () {
      _settings.annotateBearing = this.checked;
      saveSettings();
      updateHudSaveState();
    });

    // ── Settings — toggle groups (bearing format, units)
    document.querySelectorAll('.msr-toggle-group [data-value]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var group   = this.closest('.msr-toggle-group');
        var setting = group ? group.dataset.setting : null;
        if (!setting) return;
        _settings[setting] = this.dataset.value;
        saveSettings();
        group.querySelectorAll('[data-value]').forEach(function (b) {
          b.classList.toggle('active', b === btn);
        });
      });
    });

    // ── HUD close + clear + save buttons
    var hud = getHud();
    if (hud) {
      hud.querySelector('.msr-hud-close').addEventListener('click', function () {
        deactivateTool();
      });
      hud.querySelector('.msr-hud-clear').addEventListener('click', function () {
        clearPreview();
        _drawCoords = [];
        _stepCount  = 0;
        _stepPoints = [];
        hideHud();
        if (_activeTool) activateTool(_activeTool);
      });
      hud.querySelector('.msr-hud-save').addEventListener('click', function () {
        if (_lastSaveCallback) _lastSaveCallback();
        clearPreview();
        _drawCoords = [];
        _stepCount  = 0;
        _stepPoints = [];
        hideHud();
        if (_activeTool) activateTool(_activeTool);
      });
    }

    // ── Footer: Undo / Redo
    wire('msr-undo-btn', 'click', function () {
      var ur = window.PS_UNDO_REDO;
      if (ur && ur.canUndo) ur.undo();
      updateFooterButtons();
    });
    wire('msr-redo-btn', 'click', function () {
      var ur = window.PS_UNDO_REDO;
      if (ur && ur.canRedo) ur.redo();
      updateFooterButtons();
    });

    // ── Footer: Clear All Measurements
    wire('msr-clear-all-btn', 'click', function () {
      if (!confirm('Clear all measurement annotations? This cannot be undone after confirmation.')) return;
      var store = getStore();
      if (!store) return;
      var fc  = store.getState().annotations;   // Bug 1 fix: store has no getAnnotations(); use getState()
      var ids = (fc.features || [])
        .filter(function (f) {
          var ft = f.properties && f.properties.featureType;
          return ft && ft.indexOf('measure-') === 0;
        })
        .map(function (f) { return f.id; });
      if (ids.length > 0) store.deleteAnnotations(ids);
    });

    // ── Subscribe to store for undo/redo button updates
    var store = getStore();
    if (store) store.subscribe(updateFooterButtons);
  }

  function updateFooterButtons() {
    var ur = window.PS_UNDO_REDO;
    var undoBtn = document.getElementById('msr-undo-btn');
    var redoBtn = document.getElementById('msr-redo-btn');
    if (undoBtn) undoBtn.disabled = !(ur && ur.canUndo);
    if (redoBtn) redoBtn.disabled = !(ur && ur.canRedo);
  }

  // ══ Auto-Dim panel render (called when auto-dim tool is opened) ═══════════

  function renderAutoDimOptions() {
    var panel = document.getElementById('msr-autodim-opts');
    if (!panel) return;
    panel.hidden = (_activeTool !== 'auto-dim');
  }

  // ══ Tab lifecycle ══════════════════════════════════════════════════════════

  function onMeasureTabActivated() {
    loadSettings();
    wireMapEvents();
    ensurePreviewLayers();
    wirePanelEvents();
    updateSettingsUI();
    updateAdvancedToggle();
    updateFooterButtons();
    updateToolButtons();
    // Keyboard handler active only while this tab is open
    document.addEventListener('keydown', onMsrKeyDown);
  }

  function onMeasureTabDeactivated() {
    document.removeEventListener('keydown', onMsrKeyDown);
    deactivateTool();
  }

  // ══ Export ════════════════════════════════════════════════════════════════

  window.PS_MEASURE_TOOL = {
    onMeasureTabActivated:   onMeasureTabActivated,
    onMeasureTabDeactivated: onMeasureTabDeactivated,
    isActive:                function () { return _activeTool !== null; },
    getActiveTool:           function () { return _activeTool; },
    deactivate:              deactivateTool,
    /** Exposed constant so it can be imported by tests or other modules. */
    COLLINEARITY_THRESHOLD_DEG: COLLINEARITY_THRESHOLD_DEG,
  };

}());
