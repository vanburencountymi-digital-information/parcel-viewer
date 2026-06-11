/**
 * drawing-tools.js — DrawingTools (Phase 2)
 *
 * Implements the Drawing tab UI interactions and base drawing primitives:
 * Point, Polyline, Polygon, Circle, Freehand, Text Label, Callout.
 *
 * Architecture:
 *  - All map interaction (click, mousemove, dblclick) is wired after
 *    window.PS_MAP is available (polled on startup).
 *  - In-progress geometry is rendered via the 'draw-preview-source' GeoJSON
 *    source added by map.js setupAnnotationLayers().
 *  - Snap candidates are passed to PS_SNAPPING_ENGINE on every mousemove.
 *  - Completed features are committed to PS_ANNOTATION_STORE (triggering
 *    automatic undo snapshot capture via PS_UNDO_REDO).
 *  - Tab activation/deactivation hooks are called by map.js initMapControlPanel.
 *
 * Depends on: annotation-store.js, undo-redo.js, snapping-engine.js, map.js
 * Exposed as: window.PS_DRAWING_TOOLS
 */
(function () {
  'use strict';

  // ── State ─────────────────────────────────────────────────────────────────
  var activeDrawTool  = null;   // 'point'|'polyline'|'polygon'|'circle'|'freehand'|'text'|'callout'|null
  var isDrawing       = false;
  var drawCoords      = [];     // accumulated vertices for polyline/polygon
  var circleCenter    = null;   // first click for circle tool
  var calloutAnchor   = null;   // first click for callout tool
  var freehandPoints  = [];
  var freehandActive  = false;
  var kbHandlers      = null;   // keyboard undo/redo handlers (attached when draw tab active)
  // Guard against the two synthetic click events that MapLibre fires before dblclick.
  // When onMapDblClick fires we set this flag; onMapClick ignores clicks while it's true.
  var _dblClickGuard  = false;

  // ── Select-tool state ──────────────────────────────────────────────────────
  var selectedAnnotationId    = null;   // id of currently selected annotation
  var selectInteraction       = null;   // null | 'moving' | 'rotating'
  var isDraggingSelect        = false;
  var selectDragStart         = null;   // { x, y, lngLat: {lng, lat} }
  var moveStartGeometry       = null;   // geometry snapshot at drag start
  var rotateCenter            = null;   // [lng, lat] centroid for rotation
  var rotateStartAngle        = null;   // angle in degrees when rotate drag started
  var rotateStartGeometry     = null;   // geometry snapshot at rotate drag start
  var rotateStartFeatureType  = null;   // featureType of the feature being rotated
  var rotateStartLabelRotation = 0;     // style.labelRotation value at drag start (Point/label)
  var rotateLiveAngle         = null;   // continuously tracked labelRotation during Point drag
  var selectPreviewGeom       = null;   // live geometry during drag (not yet committed)
  var _pendingDeselect        = false;  // deselect on mouseup if no actual drag

  // Current style — defaults mirror AnnotationStyle defaults in the spec
  var currentStyle = {
    strokeColor:  '#1d4ed8',
    strokeWidth:  2,
    strokeDash:   'solid',
    fillColor:    '#3b82f6',
    fillOpacity:  0.18,
    fontSize:     12,
    fontColor:    '#1f2937',
    arrowStart:   false,
    arrowEnd:     false,
  };

  // Preset palettes
  var STROKE_COLORS = ['#1d4ed8', '#dc2626', '#16a34a', '#d97706', '#7c3aed', '#db2777', '#0891b2', '#1f2937'];
  var FILL_COLORS   = ['#3b82f6', '#ef4444', '#22c55e', '#f59e0b', '#a78bfa', '#f472b6', '#38bdf8', '#9ca3af'];

  // ── Accessors ─────────────────────────────────────────────────────────────

  function getMap()    { return window.PS_MAP              || null; }
  function getStore()  { return window.PS_ANNOTATION_STORE || null; }
  function getEngine() { return window.PS_SNAPPING_ENGINE  || null; }

  // ── Preview source ────────────────────────────────────────────────────────

  function setPreview(geojson) {
    var map = getMap();
    if (!map) return;
    var src = map.getSource('draw-preview-source');
    if (src) src.setData(geojson || { type: 'FeatureCollection', features: [] });
  }

  function clearPreview() {
    setPreview(null);
  }

  // ── HUD (floating distance/area hint) ────────────────────────────────────

  var _hudEl = null;
  function getHUD() {
    if (!_hudEl) _hudEl = document.getElementById('drw-hud');
    return _hudEl;
  }

  function updateHUD(text) {
    var el = getHUD();
    if (!el) return;
    if (!text) { el.hidden = true; return; }
    el.textContent = text;
    el.hidden = false;
  }

  // ── Snap indicator ────────────────────────────────────────────────────────

  function showSnapIndicator(lngLat) {
    var map = getMap();
    if (!map) return;
    var src = map.getSource('snap-indicator-source');
    if (!src) return;
    src.setData({
      type: 'FeatureCollection',
      features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: lngLat }, properties: {} }],
    });
  }

  function clearSnapIndicator() {
    var map = getMap();
    if (!map) return;
    var src = map.getSource('snap-indicator-source');
    if (src) src.setData({ type: 'FeatureCollection', features: [] });
  }

  // ── Snap helper ───────────────────────────────────────────────────────────

  /**
   * Apply snapping to a raw cursor lngLat.
   * Returns [lng, lat] — either snapped or raw.
   */
  function applySnap(lngLat) {
    var engine = getEngine();
    var map    = getMap();
    if (!engine || !map || !engine.config.enabled) {
      clearSnapIndicator();
      return [lngLat.lng, lngLat.lat];
    }
    var raw    = [lngLat.lng, lngLat.lat];
    var result = engine.snap(raw, map, drawCoords);
    if (result) {
      showSnapIndicator(result.lngLat);
      return result.lngLat;
    }
    clearSnapIndicator();
    return raw;
  }

  // ── Geometry / measurement helpers ────────────────────────────────────────

  function dist2d(a, b) {
    if (typeof turf !== 'undefined') {
      return turf.distance(turf.point(a), turf.point(b), { units: 'feet' });
    }
    // Planar fallback (adequate at township scale)
    var dx = (b[0] - a[0]) * 364000 * Math.cos(a[1] * Math.PI / 180);
    var dy = (b[1] - a[1]) * 364000;
    return Math.sqrt(dx * dx + dy * dy);
  }

  function polylineLength(coords) {
    var total = 0;
    for (var i = 1; i < coords.length; i++) total += dist2d(coords[i - 1], coords[i]);
    return total;
  }

  function polygonAreaSqFt(coords) {
    if (typeof turf !== 'undefined' && coords.length >= 3) {
      try {
        var area = turf.area(turf.polygon([coords.concat([coords[0]])]));
        return area * 10.7639; // m² → ft²
      } catch (_) {}
    }
    return 0;
  }

  function fmtDist(ft) {
    return ft >= 5280 ? (ft / 5280).toFixed(2) + ' mi' : Math.round(ft) + ' ft';
  }

  function fmtArea(sqft) {
    return sqft >= 43560 ? (sqft / 43560).toFixed(2) + ' ac' : Math.round(sqft) + ' ft²';
  }

  // ── Geometry helpers (for select/move/rotate) ─────────────────────────────

  /** Recursively map over all coordinate positions in any geometry. */
  function applyToCoords(geometry, fn) {
    if (geometry.type === 'Point') {
      return { type: 'Point', coordinates: fn(geometry.coordinates.slice()) };
    }
    if (geometry.type === 'LineString') {
      return { type: 'LineString', coordinates: geometry.coordinates.map(function (c) { return fn(c.slice()); }) };
    }
    if (geometry.type === 'Polygon') {
      return {
        type: 'Polygon',
        coordinates: geometry.coordinates.map(function (ring) {
          return ring.map(function (c) { return fn(c.slice()); });
        }),
      };
    }
    return geometry; // unsupported type — return unchanged
  }

  /** Return the flat array of all positions in a geometry. */
  function getAllCoords(geometry) {
    if (geometry.type === 'Point')      return [geometry.coordinates];
    if (geometry.type === 'LineString') return geometry.coordinates;
    if (geometry.type === 'Polygon')    return geometry.coordinates[0] || [];
    return [];
  }

  /** Centroid via turf or simple average. Returns [lng, lat]. */
  function computeCentroid(geometry) {
    if (typeof turf !== 'undefined') {
      try {
        return turf.centroid({ type: 'Feature', geometry: geometry, properties: {} }).geometry.coordinates;
      } catch (_) {}
    }
    var coords = getAllCoords(geometry);
    if (!coords.length) return [0, 0];
    return [
      coords.reduce(function (s, c) { return s + c[0]; }, 0) / coords.length,
      coords.reduce(function (s, c) { return s + c[1]; }, 0) / coords.length,
    ];
  }

  /** Returns [lng, lat] for the rotate-handle point (above top-center of bbox). */
  function computeRotateHandlePos(geometry) {
    var coords = getAllCoords(geometry);
    if (!coords.length) return [0, 0];
    var minLng = Infinity, maxLng = -Infinity, minLat = Infinity, maxLat = -Infinity;
    coords.forEach(function (c) {
      if (c[0] < minLng) minLng = c[0]; if (c[0] > maxLng) maxLng = c[0];
      if (c[1] < minLat) minLat = c[1]; if (c[1] > maxLat) maxLat = c[1];
    });
    var latSpan = maxLat - minLat;
    var offset  = Math.max(latSpan * 0.35, 0.0005);
    return [(minLng + maxLng) / 2, maxLat + offset];
  }

  /** Translate all coordinates by (dlng, dlat). */
  function translateGeometry(geometry, dlng, dlat) {
    return applyToCoords(geometry, function (c) { return [c[0] + dlng, c[1] + dlat]; });
  }

  /** Rotate geometry around (cLng, cLat) by angleDeg degrees (CW). Uses turf if available. */
  function rotateGeometry(geometry, cLng, cLat, angleDeg) {
    if (typeof turf !== 'undefined') {
      try {
        return turf.transformRotate(
          { type: 'Feature', geometry: geometry, properties: {} },
          angleDeg,
          { pivot: [cLng, cLat] }
        ).geometry;
      } catch (_) {}
    }
    // Planar fallback
    var rad = angleDeg * Math.PI / 180;
    var cosA = Math.cos(rad), sinA = Math.sin(rad);
    return applyToCoords(geometry, function (c) {
      var dx = c[0] - cLng, dy = c[1] - cLat;
      return [cLng + dx * cosA - dy * sinA, cLat + dx * sinA + dy * cosA];
    });
  }

  /**
   * Angle (degrees CW from north) from center point toward cursor point.
   * Used to detect how much the user has rotated the handle.
   */
  function angleBetween(cLng, cLat, pLng, pLat) {
    var dx = pLng - cLng, dy = pLat - cLat;
    return (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360;
  }

  // ── Style factory ─────────────────────────────────────────────────────────

  function makeStyle(overrides) {
    var s = {};
    for (var k in currentStyle) if (Object.prototype.hasOwnProperty.call(currentStyle, k)) s[k] = currentStyle[k];
    if (overrides) for (var k2 in overrides) if (Object.prototype.hasOwnProperty.call(overrides, k2)) s[k2] = overrides[k2];
    return s;
  }

  // ── Selection overlay ─────────────────────────────────────────────────────

  /**
   * Push geometry into the select-overlay-source and position the rotate handle.
   * Called on selection, during drag preview, and after commit.
   */
  function updateSelectionOverlay(geometry) {
    var map = getMap();
    if (!map) return;
    var overlaySrc = map.getSource('select-overlay-source');
    if (overlaySrc) {
      overlaySrc.setData({
        type: 'FeatureCollection',
        features: [{ type: 'Feature', geometry: geometry, properties: {} }],
      });
    }
    var handlesSrc = map.getSource('select-handles-source');
    if (handlesSrc) {
      var hpos = computeRotateHandlePos(geometry);
      handlesSrc.setData({
        type: 'FeatureCollection',
        features: [{
          type: 'Feature',
          geometry: { type: 'Point', coordinates: hpos },
          properties: { handleType: 'rotate' },
        }],
      });
    }
  }

  /** Select an annotation by id: load it from the store and show the overlay. */
  function selectAnnotation(id) {
    var store = getStore();
    if (!store) return;
    var feature = store.getAnnotationById(id);
    if (!feature) return;
    selectedAnnotationId = id;
    updateSelectionOverlay(feature.geometry);
    // Show COGO edit bar when a COGO annotation is selected
    if (window.PS_COGO_TOOL) {
      var isCogo = feature.properties && feature.properties.featureType === 'cogo';
      window.PS_COGO_TOOL.setSelectedCogoAnnotation(isCogo ? id : null);
    }
  }

  /** Clear selection and remove all overlay layers. */
  function deselectAll() {
    selectedAnnotationId = null;
    selectPreviewGeom    = null;
    var map = getMap();
    if (!map) return;
    var overlaySrc = map.getSource('select-overlay-source');
    if (overlaySrc) overlaySrc.setData({ type: 'FeatureCollection', features: [] });
    var handlesSrc = map.getSource('select-handles-source');
    if (handlesSrc) handlesSrc.setData({ type: 'FeatureCollection', features: [] });
    // Hide COGO edit bar
    if (window.PS_COGO_TOOL) window.PS_COGO_TOOL.setSelectedCogoAnnotation(null);
  }

  // ── Commit ────────────────────────────────────────────────────────────────

  function commit(feature) {
    var store = getStore();
    if (!store) return null;
    return store.addAnnotation(feature);
  }

  // ── Cancel in-progress draw ───────────────────────────────────────────────

  function cancelCurrentDraw() {
    isDrawing       = false;
    drawCoords      = [];
    circleCenter    = null;
    calloutAnchor   = null;
    _dblClickGuard  = false;
    isDraggingSelect         = false;
    selectDragStart          = null;
    selectInteraction        = null;
    moveStartGeometry        = null;
    rotateStartGeometry      = null;
    rotateStartFeatureType   = null;
    rotateStartLabelRotation = 0;
    rotateLiveAngle          = null;
    rotateCenter             = null;
    rotateStartAngle         = null;
    selectPreviewGeom        = null;
    _pendingDeselect         = false;
    clearPreview();
    clearSnapIndicator();
    updateHUD(null);
    // Also clear the freehand canvas if visible
    var fc = document.getElementById('drw-freehand-canvas');
    if (fc) {
      var ctx = fc.getContext('2d');
      if (ctx) ctx.clearRect(0, 0, fc.width, fc.height);
    }
    freehandPoints = [];
    freehandActive = false;
  }

  // ── Set active draw tool ──────────────────────────────────────────────────

  function setActiveDrawTool(toolName) {
    // Toggle off on same click
    if (activeDrawTool === toolName) toolName = null;

    // Deselect when leaving select mode
    if (activeDrawTool === 'select' && toolName !== 'select') deselectAll();

    // Deactivate COGO tool when a real draw tool is chosen.
    // Guard: toolName must be non-null so that COGO's own activate() calling
    // setActiveDrawTool(null) to clear the prior draw tool doesn't self-cancel.
    if (toolName && window.PS_COGO_TOOL && window.PS_COGO_TOOL.isActive()) {
      window.PS_COGO_TOOL.deactivate();
    }

    cancelCurrentDraw();
    activeDrawTool = toolName;

    // Update button active states (includes 'select')
    var toolNames = ['select', 'point', 'polyline', 'polygon', 'circle', 'freehand', 'text', 'callout'];
    toolNames.forEach(function (t) {
      var btn = document.getElementById('drw-tool-' + t);
      if (btn) btn.classList.toggle('active', t === toolName);
    });

    var map = getMap();
    if (!map) return;

    if (toolName === 'select') {
      // Select mode: leave dragPan enabled so empty-space panning works naturally.
      // onSelectMouseDown disables it when a drag starts on an annotation.
      map.dragPan.enable();
      map.getCanvas().style.cursor = 'default';
      var fc0 = document.getElementById('drw-freehand-canvas');
      if (fc0) fc0.style.pointerEvents = 'none';
      // No undo/redo kb handlers needed for select tool
      if (kbHandlers) {
        document.removeEventListener('keydown', kbHandlers.onKeydown);
        kbHandlers = null;
      }
    } else if (toolName) {
      map.dragPan.disable();
      map.getCanvas().style.cursor = 'crosshair';
      // Enable freehand canvas pointer events
      var fc = document.getElementById('drw-freehand-canvas');
      if (fc) fc.style.pointerEvents = toolName === 'freehand' ? 'all' : 'none';
      // Attach keyboard undo/redo handlers
      if (window.PS_UNDO_REDO && !kbHandlers) {
        kbHandlers = window.PS_UNDO_REDO.getKeyboardHandlers();
        document.addEventListener('keydown', kbHandlers.onKeydown);
      }
    } else {
      map.dragPan.enable();
      map.getCanvas().style.cursor = '';
      var fc2 = document.getElementById('drw-freehand-canvas');
      if (fc2) fc2.style.pointerEvents = 'none';
      // Detach keyboard handlers
      if (kbHandlers) {
        document.removeEventListener('keydown', kbHandlers.onKeydown);
        kbHandlers = null;
      }
    }

    // Expose to map.js parcel click gating
    if (window.PS_STATE) window.PS_STATE.activeDrawTool = toolName;
  }

  // ── Map event handlers ────────────────────────────────────────────────────

  function onMapMouseMove(e) {
    if (!activeDrawTool || activeDrawTool === 'select') return;
    var snapped = applySnap(e.lngLat);

    switch (activeDrawTool) {
      case 'polyline':
        if (isDrawing && drawCoords.length >= 1) {
          var pts = drawCoords.concat([snapped]);
          previewPolyline(pts);
        }
        break;
      case 'polygon':
        if (isDrawing && drawCoords.length >= 1) {
          var pppts = drawCoords.concat([snapped]);
          previewPolygon(pppts);
        }
        break;
      case 'circle':
        if (circleCenter) previewCircle(circleCenter, snapped);
        break;
      case 'callout':
        if (calloutAnchor) {
          setPreview({
            type: 'FeatureCollection',
            features: [{
              type: 'Feature',
              geometry: { type: 'LineString', coordinates: [calloutAnchor, snapped] },
              properties: { style: makeStyle() },
            }],
          });
        }
        break;
    }
  }

  function onMapClick(e) {
    if (!activeDrawTool || activeDrawTool === 'select') return;
    // Ignore the two synthetic click events that fire before the dblclick event.
    if (_dblClickGuard) return;
    var snapped = applySnap(e.lngLat);

    switch (activeDrawTool) {
      case 'point':    handlePointClick(snapped);    break;
      case 'polyline': handlePolylineClick(snapped); break;
      case 'polygon':  handlePolygonClick(snapped);  break;
      case 'circle':   handleCircleClick(snapped);   break;
      case 'text':     handleTextClick(snapped);     break;
      case 'callout':  handleCalloutClick(snapped);  break;
    }
  }

  function onMapDblClick(e) {
    if (!activeDrawTool || activeDrawTool === 'select') return;
    if (activeDrawTool === 'polyline' && isDrawing && drawCoords.length >= 2) {
      e.preventDefault();
      // Raise the guard BEFORE finishing so the two preceding click events
      // (which MapLibre already dispatched) are dropped if they arrive late.
      _dblClickGuard = true;
      finishPolyline();
      setTimeout(function () { _dblClickGuard = false; }, 300);
    } else if (activeDrawTool === 'polygon' && isDrawing && drawCoords.length >= 3) {
      e.preventDefault();
      _dblClickGuard = true;
      finishPolygon();
      setTimeout(function () { _dblClickGuard = false; }, 300);
    }
  }

  // ── Tool: Point ───────────────────────────────────────────────────────────

  function handlePointClick(coords) {
    commit({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: coords },
      properties: { featureType: 'point', label: null, style: makeStyle({ labelRotation: 0 }) },
    });
    clearSnapIndicator();
    // remain in point tool — allows rapid placement
  }

  // ── Tool: Polyline ────────────────────────────────────────────────────────

  function handlePolylineClick(coords) {
    if (!isDrawing) {
      isDrawing = true;
      drawCoords = [coords];
    } else {
      drawCoords.push(coords);
      previewPolyline(drawCoords);
    }
  }

  function previewPolyline(coords) {
    if (coords.length < 2) return;
    setPreview({
      type: 'FeatureCollection',
      features: [{ type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: { style: makeStyle() } }],
    });
    var len = polylineLength(coords);
    updateHUD('Length: ' + fmtDist(len) + '  ·  double-click or Enter to finish  ·  Esc to cancel');
  }

  function finishPolyline() {
    if (drawCoords.length < 2) { cancelCurrentDraw(); return; }
    commit({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: drawCoords },
      properties: { featureType: 'polyline', label: null, style: makeStyle() },
    });
    cancelCurrentDraw();
  }

  // ── Tool: Polygon ─────────────────────────────────────────────────────────

  function handlePolygonClick(coords) {
    if (!isDrawing) {
      isDrawing = true;
      drawCoords = [coords];
    } else {
      drawCoords.push(coords);
      if (drawCoords.length >= 2) previewPolygon(drawCoords);
    }
  }

  function previewPolygon(coords) {
    if (coords.length < 2) return;
    var ring = coords.concat([coords[0]]);
    setPreview({
      type: 'FeatureCollection',
      features: [{ type: 'Feature', geometry: { type: 'Polygon', coordinates: [ring] }, properties: { style: makeStyle() } }],
    });
    var hud = 'Vertices: ' + coords.length;
    if (coords.length >= 3) hud += '  ·  Area: ' + fmtArea(polygonAreaSqFt(coords));
    hud += '  ·  double-click or Enter to finish  ·  Esc to cancel';
    updateHUD(hud);
  }

  function finishPolygon() {
    if (drawCoords.length < 3) { cancelCurrentDraw(); return; }
    var ring = drawCoords.concat([drawCoords[0]]);
    commit({
      type: 'Feature',
      geometry: { type: 'Polygon', coordinates: [ring] },
      properties: { featureType: 'polygon', label: null, style: makeStyle() },
    });
    cancelCurrentDraw();
  }

  // ── Tool: Circle ──────────────────────────────────────────────────────────

  function handleCircleClick(coords) {
    if (!circleCenter) {
      circleCenter = coords;
      isDrawing    = true;
      updateHUD('Click to set radius  ·  Esc to cancel');
    } else {
      finishCircle(coords);
    }
  }

  function previewCircle(center, radiusPt) {
    var radiusFt = dist2d(center, radiusPt);
    if (radiusFt < 1 || typeof turf === 'undefined') return;
    try {
      var circle = turf.circle(turf.point(center), radiusFt / 5280, { units: 'miles', steps: 64 });
      circle.properties = { style: makeStyle() };
      setPreview({ type: 'FeatureCollection', features: [circle] });
      updateHUD('Radius: ' + fmtDist(radiusFt) + '  ·  click to finish  ·  Esc to cancel');
    } catch (_) {}
  }

  function finishCircle(radiusPt) {
    var radiusFt = dist2d(circleCenter, radiusPt);
    if (radiusFt < 1 || typeof turf === 'undefined') { cancelCurrentDraw(); return; }
    try {
      var circle = turf.circle(turf.point(circleCenter), radiusFt / 5280, { units: 'miles', steps: 64 });
      commit({
        type: 'Feature',
        geometry: circle.geometry,
        properties: { featureType: 'circle', label: null, style: makeStyle() },
      });
    } catch (e) {
      console.warn('[DrawingTools] Circle creation failed:', e);
    }
    cancelCurrentDraw();
  }

  // ── Tool: Text Label ──────────────────────────────────────────────────────

  function handleTextClick(coords) {
    var text = prompt('Label text:');
    if (!text || !text.trim()) return;
    commit({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: coords },
      properties: { featureType: 'label', label: text.trim(), style: makeStyle({ labelRotation: 0 }) },
    });
  }

  // ── Tool: Callout / Leader Line ───────────────────────────────────────────
  // Click 1 = anchor (arrow tip), Click 2 = text position.
  // The line is stored as [textPos → anchor] so that arrowEnd (line-end arrow)
  // places the arrowhead at the anchor — the correct call-out tip direction.

  function handleCalloutClick(coords) {
    if (!calloutAnchor) {
      calloutAnchor = coords;
      isDrawing     = true;
      updateHUD('Click to place the label end  ·  Esc to cancel');
    } else {
      var text = prompt('Callout text:');
      if (text && text.trim()) {
        // Line goes FROM label-position TO anchor so the arrowEnd
        // arrowhead appears at the anchor, pointing inward.
        commit({
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: [coords, calloutAnchor] },
          properties: { featureType: 'callout-line', label: null, style: makeStyle({ arrowEnd: true }) },
        });
        // Text label at label-position end
        commit({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: coords },
          properties: { featureType: 'label', label: text.trim(), style: makeStyle() },
        });
      }
      calloutAnchor = null;
      cancelCurrentDraw();
    }
  }

  // ── Tool: Select / Move / Rotate ─────────────────────────────────────────

  var SELECT_DRAG_THRESHOLD = 5; // pixels before drag is recognised

  // Layers that represent clickable annotation geometry
  var ANNOT_HIT_LAYERS = ['annotation-fill', 'annotation-line', 'annotation-circle', 'annotation-labels'];

  function _selectHitLayers() {
    var map = getMap();
    if (!map) return [];
    return ANNOT_HIT_LAYERS.filter(function (l) { return !!map.getLayer(l); });
  }

  /**
   * mousedown handler — determines whether to start a move, rotate, or deselect.
   * dragPan is selectively disabled only when we capture a drag on an annotation.
   */
  function onSelectMouseDown(e) {
    if (activeDrawTool !== 'select') return;
    var map = getMap();
    if (!map) return;

    _pendingDeselect = false;
    isDraggingSelect = false;
    selectDragStart  = { x: e.point.x, y: e.point.y, lngLat: e.lngLat };

    // ① Check rotate handle first (only when something is already selected)
    if (selectedAnnotationId && map.getLayer('select-rotate-handle')) {
      var rotHits = map.queryRenderedFeatures(e.point, { layers: ['select-rotate-handle'] });
      if (rotHits.length > 0) {
        var store = getStore();
        var selFeat = store && store.getAnnotationById(selectedAnnotationId);
        if (selFeat) {
          var fType = (selFeat.properties && selFeat.properties.featureType) || null;
          selectInteraction        = 'rotating';
          rotateStartGeometry      = selFeat.geometry;
          rotateStartFeatureType   = fType;
          rotateCenter             = computeCentroid(selFeat.geometry);
          rotateStartAngle         = angleBetween(rotateCenter[0], rotateCenter[1], e.lngLat.lng, e.lngLat.lat);
          // For Point/label features, capture the current labelRotation so we can
          // accumulate the drag delta on top of it rather than replacing it from zero.
          if (selFeat.geometry.type === 'Point') {
            rotateStartLabelRotation = (selFeat.properties && selFeat.properties.style &&
              typeof selFeat.properties.style.labelRotation === 'number')
              ? selFeat.properties.style.labelRotation : 0;
            rotateLiveAngle = rotateStartLabelRotation;
          } else {
            rotateStartLabelRotation = 0;
            rotateLiveAngle          = null;
          }
          map.dragPan.disable();
          map.getCanvas().style.cursor = 'grabbing';
        }
        return;
      }
    }

    // ② Check for annotation hit
    var hitLayers = _selectHitLayers();
    var annotHits = hitLayers.length ? map.queryRenderedFeatures(e.point, { layers: hitLayers }) : [];

    if (annotHits.length > 0) {
      // Prefer features that have a _id property; fall back to feature.id
      var hit   = annotHits[0];
      var hitId = String(hit.properties._id || hit.id || '');
      if (hitId) {
        selectAnnotation(hitId);
        // Prepare for move drag
        selectInteraction = 'moving';
        var store2 = getStore();
        var feat2  = store2 && store2.getAnnotationById(hitId);
        if (feat2) moveStartGeometry = feat2.geometry;
        map.dragPan.disable();
        map.getCanvas().style.cursor = 'grabbing';
      }
    } else {
      // Clicked empty space — schedule deselect on mouseup if no drag happens
      _pendingDeselect = true;
    }
  }

  /**
   * mousemove handler — drives live preview while dragging.
   * Also handles cursor changes when hovering over annotations / the rotate handle.
   */
  function onSelectMouseMove(e) {
    if (activeDrawTool !== 'select') return;
    var map = getMap();
    if (!map) return;

    // ── Live-drag handling ──────────────────────────────────────────────────
    if (selectDragStart) {
      var dx = e.point.x - selectDragStart.x;
      var dy = e.point.y - selectDragStart.y;
      if (!isDraggingSelect && Math.sqrt(dx * dx + dy * dy) > SELECT_DRAG_THRESHOLD) {
        isDraggingSelect = true;
        _pendingDeselect = false;
      }
      if (isDraggingSelect) {
        if (selectInteraction === 'moving' && moveStartGeometry) {
          var dlng  = e.lngLat.lng - selectDragStart.lngLat.lng;
          var dlat  = e.lngLat.lat - selectDragStart.lngLat.lat;
          selectPreviewGeom = translateGeometry(moveStartGeometry, dlng, dlat);
          updateSelectionOverlay(selectPreviewGeom);
        } else if (selectInteraction === 'rotating' && rotateStartGeometry && rotateCenter) {
          var curAngle  = angleBetween(rotateCenter[0], rotateCenter[1], e.lngLat.lng, e.lngLat.lat);
          var delta     = curAngle - rotateStartAngle;
          if (rotateStartGeometry.type === 'Point') {
            // Point/label: geometry doesn't change — accumulate delta into labelRotation.
            // selectPreviewGeom must be truthy so the mouseup commit path fires.
            rotateLiveAngle   = rotateStartLabelRotation + delta;
            selectPreviewGeom = rotateStartGeometry; // unchanged geometry
            // No updateSelectionOverlay — dot position doesn't move.
          } else {
            selectPreviewGeom = rotateGeometry(rotateStartGeometry, rotateCenter[0], rotateCenter[1], delta);
            updateSelectionOverlay(selectPreviewGeom);
          }
        }
        return; // skip cursor-hover logic while dragging
      }
    }

    // ── Cursor hover hints ──────────────────────────────────────────────────
    if (selectedAnnotationId && map.getLayer('select-rotate-handle')) {
      var rh = map.queryRenderedFeatures(e.point, { layers: ['select-rotate-handle'] });
      if (rh.length > 0) { map.getCanvas().style.cursor = 'grab'; return; }
    }
    var hitLayers = _selectHitLayers();
    var hits = hitLayers.length ? map.queryRenderedFeatures(e.point, { layers: hitLayers }) : [];
    map.getCanvas().style.cursor = hits.length > 0 ? 'move' : 'default';
  }

  /**
   * mouseup handler — commits move/rotate to the store; handles deselect on empty-space click.
   * Attached to document so it fires even when the cursor leaves the map canvas.
   */
  function onSelectMouseUp(e) {
    if (activeDrawTool !== 'select') return;
    var map = getMap();

    if (isDraggingSelect && selectPreviewGeom && selectedAnnotationId) {
      var store = getStore();
      if (store) {
        // Point/label rotation: commit via style.labelRotation, not geometry transform.
        // turf.transformRotate does not meaningfully rotate a single coordinate.
        if (selectInteraction === 'rotating' &&
            rotateStartGeometry && rotateStartGeometry.type === 'Point' &&
            rotateLiveAngle !== null) {
          var existFeat = store.getAnnotationById(selectedAnnotationId);
          if (existFeat && existFeat.properties) {
            // Copy existing style, overwrite only labelRotation
            var oldStyle = existFeat.properties.style || {};
            var newStyle = {};
            for (var sk in oldStyle) {
              if (Object.prototype.hasOwnProperty.call(oldStyle, sk)) newStyle[sk] = oldStyle[sk];
            }
            newStyle.labelRotation = rotateLiveAngle;
            store.updateAnnotation(selectedAnnotationId, { properties: { style: newStyle } });
          }
        } else {
          // Line / polygon geometry rotation
          store.updateAnnotation(selectedAnnotationId, { geometry: selectPreviewGeom });
        }
        // Refresh overlay from committed state (store may have normalised it)
        var refreshed = store.getAnnotationById(selectedAnnotationId);
        if (refreshed) updateSelectionOverlay(refreshed.geometry);
      }
    }

    if (!isDraggingSelect && _pendingDeselect) {
      deselectAll();
    }

    // Reset transient drag state (keep selectedAnnotationId / overlay)
    isDraggingSelect         = false;
    selectDragStart          = null;
    selectInteraction        = null;
    moveStartGeometry        = null;
    rotateStartGeometry      = null;
    rotateStartFeatureType   = null;
    rotateStartLabelRotation = 0;
    rotateLiveAngle          = null;
    rotateCenter             = null;
    rotateStartAngle         = null;
    selectPreviewGeom        = null;
    _pendingDeselect         = false;

    if (map) {
      map.dragPan.enable();
      map.getCanvas().style.cursor = selectedAnnotationId ? 'default' : '';
    }
  }

  // ── Tool: Freehand ────────────────────────────────────────────────────────

  function initFreehandCanvas() {
    var canvas = document.getElementById('drw-freehand-canvas');
    if (!canvas) return;

    function resizeCanvas() {
      var mapEl = document.getElementById('map');
      if (!mapEl) return;
      var r = mapEl.getBoundingClientRect();
      canvas.width  = r.width;
      canvas.height = r.height;
    }

    canvas.addEventListener('pointerdown', function (e) {
      if (activeDrawTool !== 'freehand') return;
      e.preventDefault();
      canvas.setPointerCapture(e.pointerId);
      resizeCanvas();
      var ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      var r  = document.getElementById('map').getBoundingClientRect();
      var px = e.clientX - r.left;
      var py = e.clientY - r.top;
      var map = getMap();
      if (!map) return;
      var ll = map.unproject([px, py]);
      freehandPoints = [[ll.lng, ll.lat]];
      freehandActive = true;

      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.strokeStyle = currentStyle.strokeColor;
      ctx.lineWidth   = currentStyle.strokeWidth;
      ctx.lineCap     = 'round';
      ctx.lineJoin    = 'round';
      ctx.setLineDash([]);
      canvas._ctx = ctx;
    });

    canvas.addEventListener('pointermove', function (e) {
      if (!freehandActive || !canvas._ctx) return;
      var r  = document.getElementById('map').getBoundingClientRect();
      var px = e.clientX - r.left;
      var py = e.clientY - r.top;
      canvas._ctx.lineTo(px, py);
      canvas._ctx.stroke();
      var map = getMap();
      if (!map) return;
      var ll = map.unproject([px, py]);
      freehandPoints.push([ll.lng, ll.lat]);
    });

    canvas.addEventListener('pointerup', function () {
      if (!freehandActive) return;
      freehandActive = false;
      if (canvas._ctx) {
        canvas._ctx.clearRect(0, 0, canvas.width, canvas.height);
        canvas._ctx = null;
      }

      if (freehandPoints.length >= 2) {
        var coords = freehandPoints.slice();
        // Simplify with turf if available and path has enough points
        if (typeof turf !== 'undefined' && coords.length > 10) {
          try {
            var line = turf.lineString(coords);
            var simplified = turf.simplify(line, { tolerance: 0.00005, highQuality: false });
            coords = simplified.geometry.coordinates;
          } catch (_) {}
        }
        commit({
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: coords },
          properties: { featureType: 'freehand', label: null, style: makeStyle() },
        });
      }

      freehandPoints = [];
    });
  }

  // ── Keyboard shortcuts ────────────────────────────────────────────────────

  document.addEventListener('keydown', function (e) {
    if (!activeDrawTool) return;

    // ── Select tool shortcuts ────────────────────────────────────────────────
    if (activeDrawTool === 'select') {
      if (e.key === 'Escape') { deselectAll(); return; }
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedAnnotationId) {
        var store = getStore();
        if (store) store.deleteAnnotation(selectedAnnotationId);
        deselectAll();
      }
      return;
    }

    // ── Drawing tool shortcuts ───────────────────────────────────────────────
    if (e.key === 'Escape') {
      cancelCurrentDraw();
      return;
    }
    if (e.key === 'Enter') {
      if (activeDrawTool === 'polyline' && isDrawing && drawCoords.length >= 2) {
        finishPolyline();
      } else if (activeDrawTool === 'polygon' && isDrawing && drawCoords.length >= 3) {
        finishPolygon();
      }
    }
    // Backspace removes last vertex
    if ((e.key === 'Backspace' || e.key === 'Delete') && isDrawing && drawCoords.length > 1) {
      drawCoords.pop();
      if (activeDrawTool === 'polyline') previewPolyline(drawCoords);
      if (activeDrawTool === 'polygon') previewPolygon(drawCoords);
    }
  });

  // ── Style picker ──────────────────────────────────────────────────────────

  function buildSwatches(container, colors, styleKey) {
    colors.forEach(function (c) {
      var sw = document.createElement('button');
      sw.className   = 'drw-swatch' + (c === currentStyle[styleKey] ? ' active' : '');
      sw.style.background = c;
      sw.title       = c;
      sw.type        = 'button';
      sw.addEventListener('click', function () {
        currentStyle[styleKey] = c;
        container.querySelectorAll('.drw-swatch').forEach(function (s) { s.classList.remove('active'); });
        sw.classList.add('active');
        syncCustomInput(container, styleKey);
      });
      container.appendChild(sw);
    });
  }

  function syncCustomInput(grid, styleKey) {
    var input = grid.parentElement && grid.parentElement.querySelector('.drw-color-input');
    if (input) input.value = currentStyle[styleKey];
  }

  function initStylePicker() {
    // Stroke swatches
    var strokeGrid = document.getElementById('drw-stroke-swatches');
    if (strokeGrid) {
      buildSwatches(strokeGrid, STROKE_COLORS, 'strokeColor');
      var customStroke = document.getElementById('drw-stroke-custom');
      if (customStroke) {
        customStroke.value = currentStyle.strokeColor;
        customStroke.addEventListener('input', function () {
          currentStyle.strokeColor = customStroke.value;
          strokeGrid.querySelectorAll('.drw-swatch').forEach(function (s) { s.classList.remove('active'); });
        });
      }
    }

    // Fill swatches
    var fillGrid = document.getElementById('drw-fill-swatches');
    if (fillGrid) {
      buildSwatches(fillGrid, FILL_COLORS, 'fillColor');
      var customFill = document.getElementById('drw-fill-custom');
      if (customFill) {
        customFill.value = currentStyle.fillColor;
        customFill.addEventListener('input', function () {
          currentStyle.fillColor = customFill.value;
          fillGrid.querySelectorAll('.drw-swatch').forEach(function (s) { s.classList.remove('active'); });
        });
      }
    }

    // Opacity slider
    var opacitySlider = document.getElementById('drw-fill-opacity');
    var opacityLabel  = document.getElementById('drw-fill-opacity-label');
    if (opacitySlider) {
      opacitySlider.value = Math.round(currentStyle.fillOpacity * 100);
      if (opacityLabel) opacityLabel.textContent = opacitySlider.value + '%';
      opacitySlider.addEventListener('input', function () {
        currentStyle.fillOpacity = parseInt(opacitySlider.value) / 100;
        if (opacityLabel) opacityLabel.textContent = opacitySlider.value + '%';
      });
    }

    // Stroke width slider
    var strokeWidth      = document.getElementById('drw-stroke-width');
    var strokeWidthLabel = document.getElementById('drw-stroke-width-label');
    if (strokeWidth) {
      strokeWidth.value = currentStyle.strokeWidth;
      if (strokeWidthLabel) strokeWidthLabel.textContent = strokeWidth.value + 'px';
      strokeWidth.addEventListener('input', function () {
        currentStyle.strokeWidth = parseInt(strokeWidth.value);
        if (strokeWidthLabel) strokeWidthLabel.textContent = strokeWidth.value + 'px';
      });
    }

    // Stroke dash
    var strokeDash = document.getElementById('drw-stroke-dash');
    if (strokeDash) {
      strokeDash.value = currentStyle.strokeDash;
      strokeDash.addEventListener('change', function () { currentStyle.strokeDash = strokeDash.value; });
    }

    // Font size slider
    var fontSize      = document.getElementById('drw-font-size');
    var fontSizeLabel = document.getElementById('drw-font-size-label');
    if (fontSize) {
      fontSize.value = currentStyle.fontSize;
      if (fontSizeLabel) fontSizeLabel.textContent = fontSize.value + 'px';
      fontSize.addEventListener('input', function () {
        currentStyle.fontSize = parseInt(fontSize.value);
        if (fontSizeLabel) fontSizeLabel.textContent = fontSize.value + 'px';
      });
    }

    // Arrow toggles
    var arrowStart = document.getElementById('drw-arrow-start');
    var arrowEnd   = document.getElementById('drw-arrow-end');
    if (arrowStart) {
      arrowStart.checked = currentStyle.arrowStart;
      arrowStart.addEventListener('change', function () { currentStyle.arrowStart = arrowStart.checked; });
    }
    if (arrowEnd) {
      arrowEnd.checked = currentStyle.arrowEnd;
      arrowEnd.addEventListener('change', function () { currentStyle.arrowEnd = arrowEnd.checked; });
    }

    // Collapsible toggle
    var toggleBtn   = document.getElementById('drw-style-toggle');
    var pickerPanel = document.getElementById('drw-style-picker');
    if (toggleBtn && pickerPanel) {
      toggleBtn.addEventListener('click', function () {
        pickerPanel.hidden = !pickerPanel.hidden;
        toggleBtn.classList.toggle('active', !pickerPanel.hidden);
      });
    }
  }

  // ── Layer Groups panel ────────────────────────────────────────────────────

  function initLayerGroups() {
    var store = getStore();
    if (!store) return;

    function renderGroups() {
      var container = document.getElementById('drw-layer-groups-list');
      if (!container) return;
      var state = store.getState();
      container.innerHTML = '';

      state.layerGroups.forEach(function (name) {
        var row = document.createElement('div');
        row.className = 'drw-group-row' + (name === state.activeLayerGroup ? ' active' : '');

        // Visibility checkbox
        var cb = document.createElement('input');
        cb.type    = 'checkbox';
        cb.checked = state.layerVisibility[name] !== false;
        cb.title   = 'Toggle visibility';
        cb.className = 'drw-group-check';
        cb.addEventListener('change', function () { store.setLayerVisibility(name, cb.checked); });

        // Name (click = set active)
        var label = document.createElement('span');
        label.className   = 'drw-group-name';
        label.textContent = name;
        label.title       = 'Set as active layer';
        label.addEventListener('click', function () {
          store.setActiveLayerGroup(name);
          // re-render — store subscription will fire
        });

        row.append(cb, label);

        // Delete (not for Default)
        if (name !== 'Default') {
          var del = document.createElement('button');
          del.type      = 'button';
          del.className = 'drw-group-delete';
          del.textContent = '✕';
          del.title = 'Delete group (annotations move to Default)';
          del.addEventListener('click', function () { store.removeLayerGroup(name); });
          row.appendChild(del);
        }

        container.appendChild(row);
      });
    }

    store.subscribe(renderGroups);
    renderGroups();

    var addBtn = document.getElementById('drw-add-group-btn');
    if (addBtn) {
      addBtn.addEventListener('click', function () {
        var name = prompt('New layer group name:');
        if (name && name.trim()) {
          store.addLayerGroup(name.trim());
          store.setActiveLayerGroup(name.trim());
        }
      });
    }
  }

  // ── Snap toggles ──────────────────────────────────────────────────────────

  function initSnapToggles() {
    var engine = getEngine();

    var snapToggle = document.getElementById('drw-snap-toggle');
    if (snapToggle && engine) {
      snapToggle.checked = engine.config.enabled;
      snapToggle.addEventListener('change', function () {
        engine.configure({ enabled: snapToggle.checked });
        if (!snapToggle.checked) clearSnapIndicator();
      });
    }

    var gridToggle = document.getElementById('drw-grid-toggle');
    if (gridToggle && engine) {
      gridToggle.checked = engine.config.targets.gridPoints;
      gridToggle.addEventListener('change', function () {
        engine.configure({ targets: { gridPoints: gridToggle.checked } });
      });
    }
  }

  // ── Undo/Redo buttons ─────────────────────────────────────────────────────

  function initUndoRedo() {
    var undoBtn = document.getElementById('drw-undo-btn');
    var redoBtn = document.getElementById('drw-redo-btn');
    var ur      = window.PS_UNDO_REDO;
    if (!ur) return;

    function refresh() {
      if (undoBtn) undoBtn.disabled = !ur.canUndo;
      if (redoBtn) redoBtn.disabled = !ur.canRedo;
    }

    if (undoBtn) undoBtn.addEventListener('click', function () { ur.undo(); refresh(); });
    if (redoBtn) redoBtn.addEventListener('click', function () { ur.redo(); refresh(); });

    var store = getStore();
    if (store) store.subscribe(refresh);
    refresh();
  }

  // ── Clear All ─────────────────────────────────────────────────────────────

  function initClearAll() {
    var btn = document.getElementById('drw-clear-all-btn');
    if (!btn) return;
    btn.addEventListener('click', function () {
      var store = getStore();
      if (!store) return;
      if (!store.getState().annotations.features.length) return;
      if (!confirm('Clear all annotations? This cannot be undone.')) return;
      store.clearAll();
      if (window.PS_UNDO_REDO) window.PS_UNDO_REDO.clearHistory();
      cancelCurrentDraw();
    });
  }

  // ── Tool button wiring ────────────────────────────────────────────────────

  function initToolButtons() {
    ['select', 'point', 'polyline', 'polygon', 'circle', 'freehand', 'text', 'callout'].forEach(function (t) {
      var btn = document.getElementById('drw-tool-' + t);
      if (btn) btn.addEventListener('click', function () { setActiveDrawTool(t); });
    });
    // COGO tool button — delegates to PS_COGO_TOOL
    var cogoBtn = document.getElementById('drw-tool-cogo');
    if (cogoBtn) {
      cogoBtn.addEventListener('click', function () {
        if (window.PS_COGO_TOOL) {
          if (window.PS_COGO_TOOL.isActive()) {
            window.PS_COGO_TOOL.deactivate();
          } else {
            window.PS_COGO_TOOL.activate();
          }
        }
      });
    }
  }

  // ── Map event wiring (deferred until PS_MAP is ready) ────────────────────

  var mapEventsWired = false;

  function wireMapEvents() {
    var map = getMap();
    if (!map) { setTimeout(wireMapEvents, 200); return; }
    if (mapEventsWired) return;
    mapEventsWired = true;

    // Drawing tool events
    map.on('mousemove', onMapMouseMove);
    map.on('click',     onMapClick);
    map.on('dblclick',  onMapDblClick);

    // Select tool events
    map.on('mousedown', onSelectMouseDown);
    map.on('mousemove', onSelectMouseMove);
    // mouseup on document so drag-release outside the map canvas is caught
    document.addEventListener('mouseup', onSelectMouseUp);

    initFreehandCanvas();
  }

  // ── Tab lifecycle (called from map.js initMapControlPanel) ─────────────────

  function onDrawTabActivated() {
    wireMapEvents();
  }

  function onDrawTabDeactivated() {
    if (activeDrawTool) setActiveDrawTool(null);
    if (window.PS_COGO_TOOL && window.PS_COGO_TOOL.isActive()) {
      window.PS_COGO_TOOL.deactivate();
    }
  }

  // ── Init ──────────────────────────────────────────────────────────────────

  function init() {
    initToolButtons();
    initStylePicker();
    initSnapToggles();
    initUndoRedo();
    initClearAll();
    // Layer groups need the store; PS_ANNOTATION_STORE is loaded before this script
    initLayerGroups();
    // Start polling for map
    wireMapEvents();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // ── Export ────────────────────────────────────────────────────────────────
  window.PS_DRAWING_TOOLS = {
    setActiveDrawTool:    setActiveDrawTool,
    cancelCurrentDraw:    cancelCurrentDraw,
    onDrawTabActivated:   onDrawTabActivated,
    onDrawTabDeactivated: onDrawTabDeactivated,
    getCurrentStyle:      function () { return currentStyle; },
    setStyle:             function (overrides) {
      for (var k in overrides) if (Object.prototype.hasOwnProperty.call(overrides, k)) currentStyle[k] = overrides[k];
    },
    getActiveDrawTool:    function () { return activeDrawTool; },
  };

}());
