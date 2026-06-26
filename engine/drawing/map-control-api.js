/**
 * map-control-api.js — MapControlAPI
 *
 * Stable interface through which the AI Zoning Advisor (and any other
 * programmatic caller) controls the drawing and parcel sketch tools.
 *
 * Phase 4 — Drawing tool integration (activateTool, draw*, addLabel, …) — IMPLEMENTED
 * Phase 6 — Parcel Sketch integration (proposeSplit, runComplianceCheck, …) — STUBS
 *
 * The module exposes a single object at window.PS_MAP_CONTROL_API.
 *
 * Depends on: annotation-store.js, map.js (window.PS_MAP, window.PS_STATE),
 *             drawing-tools.js (window.PS_DRAWING_TOOLS), turf (global)
 * Exposed as: window.PS_MAP_CONTROL_API
 */
(function () {
  'use strict';

  // ── Type stubs (JSDoc only — no runtime effect) ─────────────────────────
  /**
   * @typedef {Object} AnnotationStyle
   * @property {string}  [strokeColor]
   * @property {number}  [strokeWidth]
   * @property {string}  [strokeDash]
   * @property {string}  [fillColor]
   * @property {number}  [fillOpacity]
   * @property {number}  [fontSize]
   * @property {string}  [fontColor]
   * @property {boolean} [arrowStart]
   * @property {boolean} [arrowEnd]
   */

  /**
   * @typedef {Object} ComplianceResult
   * @property {boolean}  compliant
   * @property {string[]} violations
   * @property {string[]} warnings
   */

  /**
   * @typedef {Object} StructureParams
   * @property {number}         width
   * @property {number}         depth
   * @property {'feet'|'miles'} units
   * @property {[number,number]} center   [lng, lat]
   * @property {number}         rotationDeg
   * @property {string}         [label]
   */

  // ── Internal helpers ─────────────────────────────────────────────────────

  function _store()  { return window.PS_ANNOTATION_STORE || null; }
  function _map()    { return window.PS_MAP              || null; }
  function _tools()  { return window.PS_DRAWING_TOOLS    || null; }

  function _autoClose(ring) {
    if (!ring.length) return ring;
    var f = ring[0], l = ring[ring.length - 1];
    return (f[0] === l[0] && f[1] === l[1]) ? ring : ring.concat([ring[0]]);
  }

  function _azimuthToQuadrant(az) {
    var a = ((az % 360) + 360) % 360;
    if (a < 0.0001 || a > 359.9999) return 'N';
    if (Math.abs(a - 90)  < 0.0001) return 'E';
    if (Math.abs(a - 180) < 0.0001) return 'S';
    if (Math.abs(a - 270) < 0.0001) return 'W';
    function fmt(d) {
      var deg = Math.floor(d);
      var mf  = (d - deg) * 60;
      var min = Math.floor(mf);
      var sec = Math.round((mf - min) * 60);
      if (sec === 60) { min++; sec = 0; }
      if (min === 60) { deg++; min = 0; }
      return deg + '°' + (min || sec ? min + '\'' : '') + (sec ? sec + '"' : '');
    }
    if (a < 90)  return 'N ' + fmt(a)       + ' E';
    if (a < 180) return 'S ' + fmt(180 - a) + ' E';
    if (a < 270) return 'S ' + fmt(a - 180) + ' W';
    return             'N ' + fmt(360 - a)  + ' W';
  }

  // ── MapControlAPI ────────────────────────────────────────────────────────

  var api = {

    // ── Tool control ────────────────────────────────────────────────────────

    /**
     * Activate a named drawing tool.
     * @param {string} toolName  e.g. 'polyline' | 'polygon' | 'circle' | …
     */
    activateTool: function (toolName) {
      var t = _tools();
      if (t) t.setActiveDrawTool(toolName);
    },

    /** Deactivate whatever tool is currently active. */
    deactivateTool: function () {
      var t = _tools();
      if (t) t.setActiveDrawTool(null);
    },

    /**
     * @returns {string|null} name of the currently active tool, or null
     */
    getActiveTool: function () {
      var t = _tools();
      return t ? t.getActiveDrawTool() : null;
    },

    // ── Geometry control ────────────────────────────────────────────────────

    /**
     * Place a point annotation.
     * @param {[number,number]} lngLat
     * @param {Object}          [properties]
     * @returns {string} annotation id
     */
    drawPoint: function (lngLat, properties) {
      var s = _store();
      if (!s) return '';
      return s.addAnnotation({
        geometry:   { type: 'Point', coordinates: lngLat },
        properties: Object.assign({ featureType: 'point' }, properties || {}),
      });
    },

    /**
     * Draw a polyline annotation.
     * @param {[number,number][]} coordinates
     * @param {Object}            [properties]
     * @returns {string} annotation id
     */
    drawPolyline: function (coordinates, properties) {
      var s = _store();
      if (!s) return '';
      return s.addAnnotation({
        geometry:   { type: 'LineString', coordinates: coordinates },
        properties: Object.assign({ featureType: 'polyline' }, properties || {}),
      });
    },

    /**
     * Draw a polygon annotation.
     * @param {[number,number][]} coordinates  outer ring (will be auto-closed)
     * @param {Object}            [properties]
     * @returns {string} annotation id
     */
    drawPolygon: function (coordinates, properties) {
      var s = _store();
      if (!s) return '';
      return s.addAnnotation({
        geometry:   { type: 'Polygon', coordinates: [_autoClose(coordinates)] },
        properties: Object.assign({ featureType: 'polygon' }, properties || {}),
      });
    },

    /**
     * Draw a circle annotation approximated as a polygon.
     * @param {[number,number]} center
     * @param {number}          radiusFt
     * @param {Object}          [properties]
     * @returns {string} annotation id
     */
    drawCircle: function (center, radiusFt, properties) {
      var s = _store();
      if (!s) return '';
      var geom;
      if (typeof turf !== 'undefined') {
        var radiusMi = radiusFt / 5280;
        geom = turf.circle(center, radiusMi, { units: 'miles', steps: 64 }).geometry;
      } else {
        var pts = [];
        var latRad = center[1] * Math.PI / 180;
        var dLng = (radiusFt / 5280) / (Math.cos(latRad) * 69.172);
        var dLat = (radiusFt / 5280) / 69.172;
        for (var i = 0; i < 64; i++) {
          var ang = (i / 64) * 2 * Math.PI;
          pts.push([center[0] + dLng * Math.cos(ang), center[1] + dLat * Math.sin(ang)]);
        }
        pts.push(pts[0]);
        geom = { type: 'Polygon', coordinates: [pts] };
      }
      return s.addAnnotation({
        geometry:   geom,
        properties: Object.assign({ featureType: 'circle', radiusFt: radiusFt }, properties || {}),
      });
    },

    /**
     * Place a rectangular structure footprint.
     * @param {StructureParams} params
     * @returns {string} annotation id
     */
    placeStructure: function (params) {
      var s = _store();
      if (!s || typeof turf === 'undefined') return '';
      var p      = params || {};
      var center = p.center     || [0, 0];
      var wFt    = p.width      || 0;
      var dFt    = p.depth      || 0;
      var units  = p.units      || 'feet';
      var rotDeg = p.rotationDeg || 0;
      var wMi = units === 'feet' ? wFt / 5280 : wFt;
      var dMi = units === 'feet' ? dFt / 5280 : dFt;
      var latRad = center[1] * Math.PI / 180;
      var halfW  = (wMi / 2) / (Math.cos(latRad) * 69.172);
      var halfD  = (dMi / 2) / 69.172;
      var ring = [
        [center[0] - halfW, center[1] - halfD],
        [center[0] + halfW, center[1] - halfD],
        [center[0] + halfW, center[1] + halfD],
        [center[0] - halfW, center[1] + halfD],
        [center[0] - halfW, center[1] - halfD],
      ];
      var geom = turf.transformRotate(turf.polygon([ring]), rotDeg, { pivot: center }).geometry;
      return s.addAnnotation({
        geometry:   geom,
        properties: { featureType: 'polygon', label: p.label || null },
      });
    },

    /**
     * Place a text label annotation.
     * @param {[number,number]} lngLat
     * @param {string}          text
     * @returns {string} annotation id
     */
    addLabel: function (lngLat, text) {
      var s = _store();
      if (!s) return '';
      return s.addAnnotation({
        geometry:   { type: 'Point', coordinates: lngLat },
        properties: { featureType: 'label', label: text },
      });
    },

    // ── State reading ────────────────────────────────────────────────────────

    /**
     * @returns {GeoJSON.FeatureCollection} all annotations currently in the store
     */
    getAnnotations: function () {
      var s = _store();
      return s ? s.getState().annotations : { type: 'FeatureCollection', features: [] };
    },

    /**
     * @param {string} id
     * @returns {GeoJSON.Feature|null}
     */
    getAnnotationById: function (id) {
      var s = _store();
      return s ? s.getAnnotationById(id) : null;
    },

    /**
     * Returns the currently selected parcels from the main selection set.
     * @returns {GeoJSON.Feature[]}
     */
    getSelectedParcels: function () {
      if (window.PS_PARCEL_INDEX && window.PS_STATE && window.PS_STATE.selectedPins) {
        var pins = window.PS_STATE.selectedPins;
        return (window.PS_PARCEL_INDEX || []).filter(function (f) {
          var pin = f.properties && (f.properties.pin || f.properties.PIN);
          return pins.indexOf(pin) !== -1;
        });
      }
      return [];
    },

    /**
     * @returns {string} name of the active annotation layer group
     */
    getActiveLayerGroup: function () {
      var s = _store();
      return s ? s.getState().activeLayerGroup : 'Default';
    },

    // ── Annotation management ────────────────────────────────────────────────

    /**
     * Delete a single annotation by id.
     * @param {string} id
     */
    deleteAnnotation: function (id) {
      var s = _store();
      if (s) s.deleteAnnotation(id);
    },

    /** Clear all annotations. */
    clearAnnotations: function () {
      var s = _store();
      if (s) s.clearAll();
    },

    /**
     * Update the visual style of an annotation.
     * @param {string}                 id
     * @param {Partial<AnnotationStyle>} style
     */
    updateAnnotationStyle: function (id, style) {
      var s = _store();
      if (s) s.updateAnnotation(id, { properties: { style: style } });
    },

    // ── Parcel Sketch (stubbed for Phase 6) ─────────────────────────────────

    /**
     * Propose splitting a parcel along a drawn line.
     * @param {string}         parcelId
     * @param {GeoJSON.Feature} splitLine
     */
    proposeSplit: function (parcelId, splitLine) {
      console.log('[MapControlAPI] proposeSplit() — Phase 6', { parcelId: parcelId, splitLine: splitLine });
      // Phase 6: turf.lineSplit() then display proposed sub-parcels
    },

    /**
     * Propose combining multiple parcels into one.
     * @param {string[]} parcelIds
     */
    proposeCombination: function (parcelIds) {
      console.log('[MapControlAPI] proposeCombination() — Phase 6', { parcelIds: parcelIds });
      // Phase 6: turf.union() then display proposed merged parcel
    },

    /**
     * Run zoning compliance checks against a drawn geometry.
     * @param {GeoJSON.Feature} geometry
     * @returns {ComplianceResult}
     */
    runComplianceCheck: function (geometry) {
      console.log('[MapControlAPI] runComplianceCheck() — Phase 6', { geometry: geometry });
      // Phase 6: setback rules, lot coverage, dimensional standards
      return { compliant: true, violations: [], warnings: [] };
    },

    // ── COGO (Phase 3 — already implemented) ────────────────────────────────

    /**
     * Open the COGO Bearing-Distance Traverse panel, optionally pre-seeded with legs.
     */
    drawCOGOTraverse: function (params) {
      if (!window.PS_COGO_TOOL) return;
      var p = params || {};
      if (p.legs && p.legs.length) {
        window.PS_COGO_TOOL.openWithLegs(null, {
          startPoint:      p.startPoint || null,
          cogoLegs:        p.legs,
          bowditchApplied: false,
        });
      } else {
        window.PS_COGO_TOOL.activate();
      }
    },

    /** Export the current parcel sketch proposal (PDF/GeoJSON/DXF). */
    exportProposal: function () {
      console.log('[MapControlAPI] exportProposal() — Phase 6');
      // Phase 6: /export endpoint
    },

    // ── Measurement tools ────────────────────────────────────────────────────

    /**
     * Return quick info for a parcel (area, perimeter, estimated dimensions).
     * @param {string} parcelId  PIN of the parcel
     * @returns {{ pin, acres, sqft, perimFt, estDimLong, estDimShort, zoning, owner }}
     */
    quickParcelInfo: function (parcelId) {
      var empty = { pin: parcelId, acres: 0, sqft: 0, perimFt: 0, estDimLong: 0, estDimShort: 0, zoning: '', owner: '' };
      if (!window.PS_PARCEL_INDEX || typeof turf === 'undefined') return empty;
      var f = window.PS_PARCEL_INDEX.find(function (feat) {
        var pin = feat.properties && (feat.properties.pin || feat.properties.PIN);
        return pin === parcelId;
      });
      if (!f || !f.geometry) return empty;
      var areaSqM  = turf.area(f);
      var areaSqFt = areaSqM * 10.7639;
      var line     = turf.polygonToLine(f);
      var perimFt  = turf.length(line, { units: 'kilometers' }) * 1000 * 3.28084;
      var bbox     = turf.bbox(f);
      var estW     = turf.distance([bbox[0], bbox[1]], [bbox[2], bbox[1]], { units: 'miles' }) * 5280;
      var estH     = turf.distance([bbox[0], bbox[1]], [bbox[0], bbox[3]], { units: 'miles' }) * 5280;
      return {
        pin:        parcelId,
        acres:      Math.round(areaSqFt / 43560 * 1000) / 1000,
        sqft:       Math.round(areaSqFt),
        perimFt:    Math.round(perimFt),
        estDimLong: Math.round(Math.max(estW, estH)),
        estDimShort:Math.round(Math.min(estW, estH)),
        zoning:     (f.properties && f.properties.zoning) || '',
        owner:      (f.properties && (f.properties.owner_name || f.properties.OWNER_NAME)) || '',
      };
    },

    /**
     * Measure area of a polygon.
     * @param {[number,number][]} coordinates  outer ring (auto-closed)
     * @returns {{ acres, sqft, perimFt, estDimLong, estDimShort, annotationId }}
     */
    measureArea: function (coordinates) {
      var empty = { acres: 0, sqft: 0, perimFt: 0, estDimLong: 0, estDimShort: 0, annotationId: '' };
      if (typeof turf === 'undefined') return empty;
      var ring     = _autoClose(coordinates);
      var poly     = turf.polygon([ring]);
      var areaSqM  = turf.area(poly);
      var areaSqFt = areaSqM * 10.7639;
      var perimFt  = turf.length(turf.polygonToLine(poly), { units: 'kilometers' }) * 1000 * 3.28084;
      var bbox     = turf.bbox(poly);
      var estW     = turf.distance([bbox[0], bbox[1]], [bbox[2], bbox[1]], { units: 'miles' }) * 5280;
      var estH     = turf.distance([bbox[0], bbox[1]], [bbox[0], bbox[3]], { units: 'miles' }) * 5280;
      var label    = (areaSqFt / 43560).toFixed(3) + ' ac';
      var annotationId = '';
      var s = _store();
      if (s) {
        annotationId = s.addAnnotation({
          geometry:   { type: 'Polygon', coordinates: [ring] },
          properties: { featureType: 'polygon', labelAuto: true, label: label },
        });
      }
      return {
        acres:       Math.round(areaSqFt / 43560 * 1000) / 1000,
        sqft:        Math.round(areaSqFt),
        perimFt:     Math.round(perimFt),
        estDimLong:  Math.round(Math.max(estW, estH)),
        estDimShort: Math.round(Math.min(estW, estH)),
        annotationId: annotationId,
      };
    },

    /**
     * Measure distance along a polyline.
     * @param {[number,number][]} coordinates  waypoints
     * @returns {{ totalFt, segments, longestFt, shortestFt, annotationId }}
     */
    measureDistance: function (coordinates) {
      var empty = { totalFt: 0, segments: 0, longestFt: 0, shortestFt: 0, annotationId: '' };
      if (typeof turf === 'undefined' || coordinates.length < 2) return empty;
      var segFts = [];
      for (var i = 0; i < coordinates.length - 1; i++) {
        segFts.push(turf.distance(coordinates[i], coordinates[i + 1], { units: 'miles' }) * 5280);
      }
      var totalFt = segFts.reduce(function (a, b) { return a + b; }, 0);
      var annotationId = '';
      var s = _store();
      if (s) {
        annotationId = s.addAnnotation({
          geometry:   { type: 'LineString', coordinates: coordinates },
          properties: { featureType: 'polyline', labelAuto: true, label: Math.round(totalFt) + ' ft' },
        });
      }
      return {
        totalFt:    Math.round(totalFt * 10) / 10,
        segments:   segFts.length,
        longestFt:  Math.round(Math.max.apply(null, segFts) * 10) / 10,
        shortestFt: Math.round(Math.min.apply(null, segFts) * 10) / 10,
        annotationId: annotationId,
      };
    },

    /**
     * Get coordinates at a point in multiple formats.
     * @param {[number,number]} lngLat
     * @returns {{ decDegLat, decDegLng, dmsLat, dmsLng, statePlaneN, statePlaneE }}
     */
    getPointCoordinates: function (lngLat) {
      function toDMS(decimal, isLat) {
        var abs = Math.abs(decimal);
        var deg = Math.floor(abs);
        var mf  = (abs - deg) * 60;
        var min = Math.floor(mf);
        var sec = Math.round((mf - min) * 60 * 10) / 10;
        if (sec >= 60) { min++; sec = 0; }
        if (min >= 60) { deg++; min = 0; }
        var dir = isLat ? (decimal >= 0 ? 'N' : 'S') : (decimal >= 0 ? 'E' : 'W');
        return deg + '° ' + min + '\' ' + sec + '" ' + dir;
      }
      return {
        decDegLat:   Math.round(lngLat[1] * 1000000) / 1000000,
        decDegLng:   Math.round(lngLat[0] * 1000000) / 1000000,
        dmsLat:      toDMS(lngLat[1], true),
        dmsLng:      toDMS(lngLat[0], false),
        statePlaneN: 0,  // requires proj4 — Phase M2
        statePlaneE: 0,
      };
    },

    /**
     * Place a dimension line annotation with arrowheads.
     * @param {[number,number]} from
     * @param {[number,number]} to
     * @returns {string} annotation id
     */
    placeDimensionLine: function (from, to) {
      var s = _store();
      if (!s || typeof turf === 'undefined') return '';
      var distFt = turf.distance(from, to, { units: 'miles' }) * 5280;
      return s.addAnnotation({
        geometry:   { type: 'LineString', coordinates: [from, to] },
        properties: {
          featureType: 'polyline',
          label:       Math.round(distFt) + ' ft',
          labelAuto:   true,
          style:       { arrowStart: true, arrowEnd: true },
        },
      });
    },

    /**
     * Measure bearing and distance between two points.
     * @param {[number,number]} from
     * @param {[number,number]} to
     * @returns {{ bearingQuadrant, bearingAzimuth, backBearing, distFt, distMi }}
     */
    measureBearingDistance: function (from, to) {
      var empty = { bearingQuadrant: '', bearingAzimuth: 0, backBearing: '', distFt: 0, distMi: 0 };
      if (typeof turf === 'undefined') return empty;
      var az     = turf.bearing(from, to);
      var backAz = az >= 0 ? az - 180 : az + 180;
      var distMi = turf.distance(from, to, { units: 'miles' });
      return {
        bearingQuadrant: _azimuthToQuadrant(az),
        bearingAzimuth:  Math.round(((az % 360) + 360) % 360 * 100) / 100,
        backBearing:     _azimuthToQuadrant(backAz),
        distFt:          Math.round(distMi * 5280 * 10) / 10,
        distMi:          Math.round(distMi * 100000) / 100000,
      };
    },

    /**
     * Measure perpendicular distance from a point to a line segment.
     * @param {[number,number]} lineStart
     * @param {[number,number]} lineEnd
     * @param {[number,number]} point
     * @returns {{ perpFt, footLngLat, lineLengthFt, annotationId }}
     */
    measurePerpendicular: function (lineStart, lineEnd, point) {
      var ax = lineEnd[0]  - lineStart[0];
      var ay = lineEnd[1]  - lineStart[1];
      var bx = point[0]    - lineStart[0];
      var by = point[1]    - lineStart[1];
      var len2 = ax * ax + ay * ay;
      var t    = len2 > 0 ? Math.max(0, Math.min(1, (ax * bx + ay * by) / len2)) : 0;
      var foot = [lineStart[0] + t * ax, lineStart[1] + t * ay];
      var perpFt       = typeof turf !== 'undefined' ? turf.distance(point, foot, { units: 'miles' }) * 5280 : 0;
      var lineLengthFt = typeof turf !== 'undefined' ? turf.distance(lineStart, lineEnd, { units: 'miles' }) * 5280 : 0;
      var annotationId = '';
      var s = _store();
      if (s && perpFt > 0) {
        annotationId = s.addAnnotation({
          geometry:   { type: 'LineString', coordinates: [point, foot] },
          properties: { featureType: 'polyline', label: Math.round(perpFt) + ' ft', labelAuto: true },
        });
      }
      return {
        perpFt:       Math.round(perpFt * 10) / 10,
        footLngLat:   foot,
        lineLengthFt: Math.round(lineLengthFt * 10) / 10,
        annotationId: annotationId,
      };
    },

    /**
     * Fit a circular arc through three points and compute curve data.
     * @param {[number,number]} p1  first point on arc
     * @param {[number,number]} p2  midpoint of arc
     * @param {[number,number]} p3  endpoint of arc
     * @returns {{ radiusFt, deltaDegs, arcLengthFt, chordFt, chordBearing,
     *             tangentFt, direction, annotationId }}
     */
    measureArc: function (p1, p2, p3) {
      var empty = { radiusFt: 0, deltaDegs: 0, arcLengthFt: 0, chordFt: 0,
                    chordBearing: '', tangentFt: 0, direction: '', annotationId: '' };
      if (typeof turf === 'undefined') return empty;
      // Circumscribed circle through 3 points (2D lon/lat approximation — valid for parcel scale)
      var ax = p1[0], ay = p1[1], bx = p2[0], by = p2[1], cx = p3[0], cy = p3[1];
      var D = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
      if (Math.abs(D) < 1e-14) return empty; // collinear points
      var ux = ((ax*ax+ay*ay)*(by-cy) + (bx*bx+by*by)*(cy-ay) + (cx*cx+cy*cy)*(ay-by)) / D;
      var uy = ((ax*ax+ay*ay)*(cx-bx) + (bx*bx+by*by)*(ax-cx) + (cx*cx+cy*cy)*(bx-ax)) / D;
      var center  = [ux, uy];
      var radiusFt = turf.distance(p1, center, { units: 'miles' }) * 5280;
      // Central angle: determine arc direction from p1→p2→p3
      var a1 = Math.atan2(p1[1] - uy, p1[0] - ux);
      var a2 = Math.atan2(p2[1] - uy, p2[0] - ux);
      var a3 = Math.atan2(p3[1] - uy, p3[0] - ux);
      var ccwFull = ((a3 - a1) + 2 * Math.PI) % (2 * Math.PI);
      var ccwToP2 = ((a2 - a1) + 2 * Math.PI) % (2 * Math.PI);
      var direction, deltaRad;
      if (ccwToP2 <= ccwFull) {
        direction = 'CCW'; deltaRad = ccwFull;
      } else {
        direction = 'CW';  deltaRad = 2 * Math.PI - ccwFull;
      }
      var deltaDegs    = deltaRad * 180 / Math.PI;
      var arcLengthFt  = radiusFt * deltaRad;
      var chordFt      = turf.distance(p1, p3, { units: 'miles' }) * 5280;
      var chordBearing = _azimuthToQuadrant(turf.bearing(p1, p3));
      var tangentFt    = radiusFt * Math.tan(deltaRad / 2);
      return {
        radiusFt:    Math.round(radiusFt * 10) / 10,
        deltaDegs:   Math.round(deltaDegs * 1000) / 1000,
        arcLengthFt: Math.round(arcLengthFt * 10) / 10,
        chordFt:     Math.round(chordFt * 10) / 10,
        chordBearing: chordBearing,
        tangentFt:   Math.round(tangentFt * 10) / 10,
        direction:   direction,
        annotationId: '',  // arc rendering requires bezier spline — Phase M2
      };
    },

    /**
     * Auto-dimension all sides of a parcel.
     * @param {{ parcelId, labelContent, labelPosition, minSegmentLengthFt,
     *            detectArcs, groupName }} params
     * @returns {{ labeled, suppressed, perimFt, acres, groupName }}
     */
    dimensionParcel: function (params) {
      console.log('[MapControlAPI] dimensionParcel() — Phase M2 (boundary analysis pipeline not yet built)', params);
      return { labeled: 0, suppressed: 0, perimFt: 0, acres: 0, groupName: '' };
    },

    // ── Camera ──────────────────────────────────────────────────────────────

    /**
     * Fly the map to the bounds of a specific annotation.
     * @param {string} id
     */
    flyToAnnotation: function (id) {
      var map = _map();
      var s   = _store();
      if (!map || !s || typeof turf === 'undefined') return;
      var f = s.getAnnotationById(id);
      if (!f || !f.geometry) return;
      var bb = turf.bbox(f);
      map.fitBounds([[bb[0], bb[1]], [bb[2], bb[3]]], { padding: 60, maxZoom: 18 });
    },

    /**
     * Fit the map view to show all annotations.
     */
    fitAnnotations: function () {
      var map = _map();
      var s   = _store();
      if (!map || !s || typeof turf === 'undefined') return;
      var fc = s.getState().annotations;
      if (!fc.features.length) return;
      var bb = turf.bbox(fc);
      map.fitBounds([[bb[0], bb[1]], [bb[2], bb[3]]], { padding: 60, maxZoom: 18 });
    },
  };

  // ── Export ───────────────────────────────────────────────────────────────
  window.PS_MAP_CONTROL_API = api;

}());
