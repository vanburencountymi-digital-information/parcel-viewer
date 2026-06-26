/**
 * snapping-engine.js — SnappingEngine
 *
 * Pure spatial utility — no MapLibre or UI imports.  The map instance and
 * parcel/annotation data are received as parameters at call time so this
 * module can be unit-tested in isolation.
 *
 * Snap priority (highest → lowest):
 *   1. Parcel vertices
 *   2. Annotation vertices
 *   3. Parcel midpoints
 *   4. Annotation midpoints
 *   5. Parcel edges (closest point on segment)
 *   6. Grid points
 *   7. Right-angle lock (relative to previous draw coordinate)
 *
 * All pixel ↔ map-unit conversions use map.project() / map.unproject() so
 * snap radius stays visually constant regardless of zoom level.
 *
 * PostGIS migration note: when parcel data moves server-side the parcelIndex
 * parameter can be replaced with a thin wrapper that fetches candidates from a
 * /api/snap-candidates endpoint — snap geometry math stays identical.
 *
 * Depends on: nothing (standalone)
 * Exposed as: window.PS_SNAPPING_ENGINE
 */
(function () {
  'use strict';

  // ── SnapResult typedef ───────────────────────────────────────────────────
  /**
   * @typedef {Object} SnapResult
   * @property {[number,number]} lngLat          snapped coordinate
   * @property {string}          snapType
   * @property {string|null}     sourceFeatureId
   * @property {number}          distancePx
   */

  // ── SnappingEngine ───────────────────────────────────────────────────────

  function SnappingEngine() {
    /** @type {SnappingConfig} */
    this.config = {
      enabled:         true,
      snapRadiusPx:    14,
      targets: {
        parcelVertices:      true,
        parcelMidpoints:     true,
        parcelEdges:         false,
        annotationVertices:  true,
        annotationMidpoints: true,
        gridPoints:          false,
      },
      rightAngleLock:  false,
      gridIntervalFt:  25,
    };
  }

  /**
   * @typedef {Object} SnappingConfig
   * @property {boolean} enabled
   * @property {number}  snapRadiusPx
   * @property {{parcelVertices:boolean, parcelMidpoints:boolean, parcelEdges:boolean,
   *             annotationVertices:boolean, annotationMidpoints:boolean,
   *             gridPoints:boolean}} targets
   * @property {boolean} rightAngleLock
   * @property {number}  gridIntervalFt
   */

  // ── Public: configure ────────────────────────────────────────────────────

  /**
   * Merge settings into the current config.
   * @param {Partial<SnappingConfig>} overrides
   */
  SnappingEngine.prototype.configure = function (overrides) {
    if (overrides.targets) {
      Object.assign(this.config.targets, overrides.targets);
      delete overrides.targets;
    }
    Object.assign(this.config, overrides);
  };

  // ── Public: snap ─────────────────────────────────────────────────────────

  /**
   * Find the highest-priority snap target near the cursor.
   *
   * @param {[number,number]}   cursorLngLat        [lng, lat] of raw cursor
   * @param {maplibregl.Map}    mapInstance
   * @param {[number,number][]} currentDrawCoords   coordinates drawn so far (for right-angle)
   * @param {Object}            [options]
   * @param {GeoJSON.Feature[]} [options.parcelIndex]     override window.PS_PARCEL_INDEX
   * @param {GeoJSON.Feature[]} [options.annotationFeatures] override store features
   * @returns {SnapResult|null}
   */
  SnappingEngine.prototype.snap = function (cursorLngLat, mapInstance, currentDrawCoords, options) {
    if (!this.config.enabled) return null;
    var cfg = this.config;
    var opts = options || {};

    var parcelFeatures     = opts.parcelIndex         || (window.PS_PARCEL_INDEX || []);
    var annotationFeatures = opts.annotationFeatures  ||
      (window.PS_ANNOTATION_STORE
        ? window.PS_ANNOTATION_STORE.getVisibleAnnotations().features
        : []);

    var radius = cfg.snapRadiusPx;
    var cursor = cursorLngLat;           // [lng, lat]

    // Helper: screen-space distance from cursorLngLat to a candidate [lng,lat]
    var self = this;
    function pxDist(candidate) {
      return self._screenDistancePx(cursor, candidate, mapInstance);
    }

    var best = null;  // SnapResult | null

    function consider(lngLat, snapType, featureId) {
      var d = pxDist(lngLat);
      if (d <= radius && (!best || d < best.distancePx)) {
        best = { lngLat: lngLat, snapType: snapType, sourceFeatureId: featureId || null, distancePx: d };
      }
    }

    // 1. Parcel vertices
    if (cfg.targets.parcelVertices) {
      parcelFeatures.forEach(function (f) {
        var id = f.properties && (f.properties.pin || f.properties.PIN);
        _extractVertices(f.geometry).forEach(function (v) { consider(v, 'parcelVertex', id); });
      });
    }
    if (best) return best;

    // 2. Annotation vertices
    if (cfg.targets.annotationVertices) {
      annotationFeatures.forEach(function (f) {
        _extractVertices(f.geometry).forEach(function (v) { consider(v, 'annotationVertex', f.id); });
      });
    }
    if (best) return best;

    // 3. Parcel midpoints
    if (cfg.targets.parcelMidpoints) {
      parcelFeatures.forEach(function (f) {
        var id = f.properties && (f.properties.pin || f.properties.PIN);
        _extractSegments(f.geometry).forEach(function (seg) {
          consider(_midpoint(seg[0], seg[1]), 'parcelMidpoint', id);
        });
      });
    }
    if (best) return best;

    // 4. Annotation midpoints
    if (cfg.targets.annotationMidpoints) {
      annotationFeatures.forEach(function (f) {
        _extractSegments(f.geometry).forEach(function (seg) {
          consider(_midpoint(seg[0], seg[1]), 'annotationMidpoint', f.id);
        });
      });
    }
    if (best) return best;

    // 5. Parcel edges (closest point on each segment)
    if (cfg.targets.parcelEdges) {
      parcelFeatures.forEach(function (f) {
        var id = f.properties && (f.properties.pin || f.properties.PIN);
        _extractSegments(f.geometry).forEach(function (seg) {
          var cp = _closestPointOnSegment(cursor, seg[0], seg[1]);
          consider(cp, 'parcelEdge', id);
        });
      });
    }
    if (best) return best;

    // 6. Grid points
    if (cfg.targets.gridPoints) {
      var gp = this._nearestGridPoint(cursor, mapInstance, cfg.gridIntervalFt);
      if (gp) consider(gp, 'gridPoint', null);
    }
    if (best) return best;

    // 7. Right-angle lock (relative to previous draw coordinate)
    if (cfg.rightAngleLock && currentDrawCoords && currentDrawCoords.length > 0) {
      var prev = currentDrawCoords[currentDrawCoords.length - 1];
      var locked = this._rightAngleSnap(cursor, prev, mapInstance);
      // Right angle is always returned if enabled — it's a soft constraint, no radius check
      return { lngLat: locked, snapType: 'rightAngle', sourceFeatureId: null, distancePx: pxDist(locked) };
    }

    return null;
  };

  // ── Private: screen distance ─────────────────────────────────────────────

  /**
   * Pixel distance between two [lng,lat] coordinates in screen space.
   * @param {[number,number]} a
   * @param {[number,number]} b
   * @param {maplibregl.Map}  map
   * @returns {number} pixels
   */
  SnappingEngine.prototype._screenDistancePx = function (a, b, map) {
    var pa = map.project(a);
    var pb = map.project(b);
    var dx = pa.x - pb.x;
    var dy = pa.y - pb.y;
    return Math.sqrt(dx * dx + dy * dy);
  };

  // ── Private: right-angle lock ────────────────────────────────────────────

  /**
   * Projects the cursor onto the nearest cardinal or 45° axis from prevCoord.
   * Operates in screen-pixel space to be visually correct, then unprojects.
   * @param {[number,number]} cursor
   * @param {[number,number]} prevCoord
   * @param {maplibregl.Map}  map
   * @returns {[number,number]} snapped [lng,lat]
   */
  SnappingEngine.prototype._rightAngleSnap = function (cursor, prevCoord, map) {
    var pc  = map.project(cursor);
    var pp  = map.project(prevCoord);
    var dx  = pc.x - pp.x;
    var dy  = pc.y - pp.y;
    var angle = Math.atan2(dy, dx);                       // radians
    var snap  = Math.round(angle / (Math.PI / 2)) * (Math.PI / 2);  // nearest 90°
    var dist  = Math.sqrt(dx * dx + dy * dy);
    var sx    = pp.x + dist * Math.cos(snap);
    var sy    = pp.y + dist * Math.sin(snap);
    var ll    = map.unproject([sx, sy]);
    return [ll.lng, ll.lat];
  };

  // ── Private: nearest grid point ──────────────────────────────────────────

  /**
   * Find the nearest grid intersection to the cursor given a grid interval in feet.
   * Grid is anchored to the origin (0°, 0°) — sufficient for local township use.
   * 1 foot ≈ 0.0000030856° latitude (constant); longitude degree varies with lat.
   * @param {[number,number]} cursor   [lng, lat]
   * @param {maplibregl.Map}  map
   * @param {number}          intervalFt
   * @returns {[number,number]} snapped [lng,lat]
   */
  SnappingEngine.prototype._nearestGridPoint = function (cursor, map, intervalFt) {
    var FT_PER_DEG_LAT = 364000;  // approx feet per degree latitude
    var latStep = intervalFt / FT_PER_DEG_LAT;
    var lngStep = intervalFt / (FT_PER_DEG_LAT * Math.cos(cursor[1] * Math.PI / 180));

    var snappedLat = Math.round(cursor[1] / latStep) * latStep;
    var snappedLng = Math.round(cursor[0] / lngStep) * lngStep;
    return [snappedLng, snappedLat];
  };

  // ── Pure geometry helpers (module-private) ───────────────────────────────

  /**
   * Extract all vertex coordinates from a GeoJSON geometry.
   * @param {GeoJSON.Geometry} geometry
   * @returns {[number,number][]}
   */
  function _extractVertices(geometry) {
    if (!geometry) return [];
    switch (geometry.type) {
      case 'Point':           return [geometry.coordinates];
      case 'LineString':      return geometry.coordinates.slice();
      case 'MultiPoint':      return geometry.coordinates.slice();
      case 'Polygon':         return geometry.coordinates.reduce(function (a, r) { return a.concat(r); }, []);
      case 'MultiLineString': return geometry.coordinates.reduce(function (a, r) { return a.concat(r); }, []);
      case 'MultiPolygon':    return geometry.coordinates.reduce(function (a, p) {
        return a.concat(p.reduce(function (b, r) { return b.concat(r); }, []));
      }, []);
      default: return [];
    }
  }

  /**
   * Extract all edge segments [start, end] from a GeoJSON geometry.
   * @param {GeoJSON.Geometry} geometry
   * @returns {[[number,number],[number,number]][]}
   */
  function _extractSegments(geometry) {
    if (!geometry) return [];
    var rings = [];
    switch (geometry.type) {
      case 'LineString':      rings = [geometry.coordinates];       break;
      case 'MultiLineString': rings = geometry.coordinates;         break;
      case 'Polygon':         rings = geometry.coordinates;         break;
      case 'MultiPolygon':
        geometry.coordinates.forEach(function (p) { rings = rings.concat(p); });
        break;
      default: return [];
    }
    var segs = [];
    rings.forEach(function (ring) {
      for (var i = 0; i < ring.length - 1; i++) {
        segs.push([ring[i], ring[i + 1]]);
      }
    });
    return segs;
  }

  /**
   * Midpoint of two [lng,lat] coordinates.
   * @param {[number,number]} a
   * @param {[number,number]} b
   * @returns {[number,number]}
   */
  function _midpoint(a, b) {
    return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  }

  /**
   * Closest point on segment [a,b] to point [p] (all [lng,lat]).
   * Uses planar approximation — acceptable at township scale.
   * @param {[number,number]} p
   * @param {[number,number]} a
   * @param {[number,number]} b
   * @returns {[number,number]}
   */
  function _closestPointOnSegment(p, a, b) {
    var dx = b[0] - a[0];
    var dy = b[1] - a[1];
    var len2 = dx * dx + dy * dy;
    if (len2 === 0) return a.slice();
    var t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    return [a[0] + t * dx, a[1] + t * dy];
  }

  // ── Export ───────────────────────────────────────────────────────────────
  window.PS_SNAPPING_ENGINE = new SnappingEngine();

}());
