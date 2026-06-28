/**
 * parcel-labels.js — Cartographic parcel owner / attribute labels.
 *
 * Renders a MapLibre symbol layer of per-parcel labels built from
 * window.PS_PARCEL_INDEX (already in memory).
 *
 * Cartographic rules applied:
 *  1. PREFER HORIZONTAL — only rotate when the label won't fit east-west.
 *     Angle is computed per zoom level (stored as _a13…_a17) because a
 *     small parcel that needs rotation at z13 may go horizontal at z16.
 *  2. FONT SCALES WITH PARCEL SIZE — larger farms get a bigger font;
 *     small lots get a smaller font.  All within the chosen S/M/L band.
 *     Stored as _fs_s / _fs_m / _fs_l on each centroid feature.
 *  3. MEATIEST POINT — label anchor is the pole of inaccessibility
 *     (grid-search for the interior point farthest from all edges).
 *     Beats turf.pointOnFeature which can land at a concave vertex.
 *  4. TIER REDUCTION — owner names reduced across four tiers based on
 *     the parcel's short-axis screen size at each zoom level.
 *
 * localStorage key: 'parcel_labels_state'
 * Exposes:  window.PS_PARCEL_LABELS
 *           { activate, deactivate, setField, setRotate, setSize }
 */
(function () {
  'use strict';

  // ── Configuration ────────────────────────────────────────────────────────

  var SOURCE_ID  = 'parcel-label-source';
  var MIN_ZOOM   = 13;

  // ── Three-layer priority architecture ────────────────────────────────────
  // Layers are added to the map in this order.  MapLibre collision detection
  // is first-come-first-served, so XL labels claim their space before MD,
  // and MD before SM.  Small parcels only appear at zoom 14+ to keep the
  // township view uncluttered.
  var _LAYER_DEFS = [
    {
      id:      'plbl-XL',
      minzoom:  13,
      filter:  ['>=', ['coalesce', ['get', '_acres'], 0], 40],
    },
    {
      id:      'plbl-MD',
      minzoom:  13,
      filter:  ['all',
                  ['>=', ['coalesce', ['get', '_acres'], 0], 5],
                  ['<',  ['coalesce', ['get', '_acres'], 0], 40]],
    },
    {
      id:      'plbl-SM',
      minzoom:  13,   // tiny lots get tiny labels at all zoom levels (~6px)
      filter:  ['<', ['coalesce', ['get', '_acres'], 0], 5],
    },
  ];
  var LAT_RAD        = 42 * Math.PI / 180;
  var LAT_FACTOR     = Math.cos(LAT_RAD);        // ≈ 0.743 at Michigan latitude
  // Label fit constants. (Text width is measured for real now — DIC-520 — so
  // there's no px-per-char proxy.)
  var LINE_HEIGHT_FAC = 1.30;  // line-height as a fraction of font-size (px)
  var HORIZ_PAD       = 0.96;  // allow label to fill 96% of parcel width (favor horizontal, DIC-520)
  var VERT_PAD        = 0.88;  // allow label to fill 88% of parcel height
  var MAX_WRAP_LINES  = 4;     // never stack more than 4 lines at 0°
  var POLYLABEL_STEPS = 10;    // grid resolution for meatiest-point search

  var FONT_SIZES     = { small: 8, medium: 10, large: 13 };

  // ── State ─────────────────────────────────────────────────────────────────

  var _active      = false;
  var _field       = 'owner';
  var _size        = 'medium';
  var _computed    = null;
  var _sourceAdded = false;
  // Track which of the three layers has been added to the map
  var _layersAdded = { 'plbl-XL': false, 'plbl-MD': false, 'plbl-SM': false };

  // ── Name-type detection ───────────────────────────────────────────────────

  var _CORP_SUFFIXES = ['LLC','INC','CORP','CO','LTD','LP','LLP','PC','PLLC','PLC'];
  var _TRUST_WORDS   = ['TRUST','TRUSTEE','TR'];
  var _GOVT_WORDS    = ['TOWNSHIP','COUNTY','STATE','DEPT','DEPARTMENT',
                        'AUTHORITY','CITY','VILLAGE','MICHIGAN','FEDERAL'];
  var _ET_RE         = /\b(ET\s+UX|ET\s+VIR|ET\s+AL)\b/gi;
  var _PARTY_SPLIT   = /\s*[&+]\s*|\s+AND\s+(?=[A-Z])/;
  var _LAST_PREFIXES = ['VAN','DE','LA','MC','MAC','ST','DEN','TEN',
                        'LE','DI','EL','AL','O'];

  function _hasWord(str, words) {
    for (var i = 0; i < words.length; i++) {
      if (str.indexOf(words[i]) !== -1) return true;
    }
    return false;
  }

  function _detectType(raw) {
    var u    = raw.toUpperCase().trim();
    var tok  = u.split(/\s+/);
    var last = tok[tok.length - 1];
    if (_CORP_SUFFIXES.indexOf(last) !== -1) return 'corporate';
    if (_hasWord(u, _TRUST_WORDS))           return 'trust';
    if (_hasWord(u, _GOVT_WORDS))            return 'govt';
    return 'person';
  }

  function _parsePerson(raw) {
    var tok = raw.trim().replace(_ET_RE, '').trim().split(/\s+/).filter(Boolean);
    if (!tok.length) return { last: raw.trim(), first: '', middle: '' };
    if (tok.length === 1) return { last: tok[0], first: '', middle: '' };

    var last, first, rest;
    if (_LAST_PREFIXES.indexOf(tok[0]) !== -1 && tok.length >= 2) {
      last  = tok[0] + ' ' + tok[1];
      first = tok[2] || '';
      rest  = tok.slice(3);
    } else {
      last  = tok[0];
      first = tok[1] || '';
      rest  = tok.slice(2);
    }
    var SUFFIXES = ['JR','SR','II','III','IV','V'];
    rest = rest.filter(function (t) { return SUFFIXES.indexOf(t) === -1; });
    return { last: last, first: first, middle: rest.join(' ') };
  }

  function _splitParties(raw) {
    var parts = raw.split(_PARTY_SPLIT).map(function (s) {
      return s.replace(_ET_RE, '').trim();
    }).filter(Boolean);
    return parts.length ? parts : [raw];
  }

  var _TRUST_SFX_RE = /\s*(REVOCABLE|IRREVOCABLE|LIVING|FAMILY|LV|REV|IRREV)?\s*(TRUST|TRUSTEE|TR)\s*(\d{4})?$/i;

  function _buildTrustTiers(raw) {
    var stripped    = raw.replace(_TRUST_SFX_RE, '').trim();
    var p           = _parsePerson(stripped);
    var last        = p.last || stripped;
    var nameDropMid = p.first ? p.first + ' ' + last : last;
    var nameInitF   = p.first ? p.first[0] + ' ' + last : last;
    var fullSuffix  = raw.match(_TRUST_SFX_RE);
    var sfx4        = fullSuffix ? fullSuffix[0].trim() : 'TRUST';
    return {
      lbl_4: nameDropMid + ' ' + sfx4,
      lbl_3: nameDropMid + ' TRUST',
      lbl_2: nameInitF   + ' TRUST',
      lbl_1: last        + ' TR',
    };
  }

  var _ABBREV = [
    [/\bPROPERTIES\b/gi,'PROP'],   [/\bASSOCIATES\b/gi,'ASSOC'],
    [/\bMANAGEMENT\b/gi,'MGMT'],   [/\bDEVELOPMENT\b/gi,'DEV'],
    [/\bINVESTMENTS\b/gi,'INV'],   [/\bENTERPRISES\b/gi,'ENT'],
    [/\bCORPORATION\b/gi,'CORP'],  [/\bREVOCABLE\b/gi,'REV'],
    [/\bIRREVOCABLE\b/gi,'IRREV'],[/\bDEPARTMENT\b/gi,'DEPT'],
  ];
  var _DROP_SFX_RE = /\s*(LLC|INC|CORP|LTD|LP|LLP|PC|PLLC|PLC)\.?$/gi;

  function _buildEntityTiers(raw) {
    var t4 = raw.trim();
    var t3 = t4;
    _ABBREV.forEach(function (p) { t3 = t3.replace(p[0], p[1]); });
    var t2    = t3.replace(_DROP_SFX_RE, '').trim();
    var t1    = t2.split(/\s+/).slice(0, 2).join(' ');
    return { lbl_4: t4, lbl_3: t3, lbl_2: t2, lbl_1: t1 };
  }

  function _buildPersonTiers(parties) {
    var etAl = parties.length > 2 ? ' ET AL' : '';
    var p0   = _parsePerson(parties[0]);
    var p1   = parties[1] ? _parsePerson(parties[1]) : null;

    // "SMITH JOHN AND MARY" — single-token second party = shared last name
    if (p1 && !p1.first && parties[1] && parties[1].trim().indexOf(' ') === -1) {
      p1 = { last: p0.last, first: p1.last, middle: '' };
    }

    if (!p1) {
      var full      = [p0.first, p0.middle, p0.last].filter(Boolean).join(' ');
      var dropMid   = [p0.first, p0.last].filter(Boolean).join(' ');
      var initFirst = p0.first ? p0.first[0] + ' ' + p0.last : p0.last;
      return {
        lbl_4: full      || p0.last,
        lbl_3: dropMid   || p0.last,
        lbl_2: initFirst,
        lbl_1: p0.last,
      };
    }

    var sharedLast = p0.last && p1.last &&
                     p0.last.toUpperCase() === p1.last.toUpperCase();

    if (sharedLast) {
      var f0f  = [p0.first, p0.middle].filter(Boolean).join(' ');
      var f1f  = [p1.first, p1.middle].filter(Boolean).join(' ');
      var f0   = p0.first || '';
      var f1   = p1.first || '';
      var i0   = f0 ? f0[0] : '';
      var i1   = f1 ? f1[0] : '';
      return {
        lbl_4: (f0f && f1f ? f0f + ' &\n' + f1f + ' ' + p0.last : p0.last) + etAl,
        lbl_3: (f0  && f1  ? f0  + ' &\n' + f1  + ' ' + p0.last : p0.last) + etAl,
        lbl_2: (i0  && i1  ? i0  + ' & '  + i1  + ' ' + p0.last : p0.last) + etAl,
        lbl_1: p0.last + etAl,
      };
    }

    var n0full = [p0.first, p0.middle, p0.last].filter(Boolean).join(' ');
    var n1full = [p1.first, p1.middle, p1.last].filter(Boolean).join(' ');
    var n0drop = [p0.first, p0.last].filter(Boolean).join(' ');
    var n1drop = [p1.first, p1.last].filter(Boolean).join(' ');
    var n0init = (p0.first ? p0.first[0] + ' ' : '') + p0.last;
    var n1init = (p1.first ? p1.first[0] + ' ' : '') + p1.last;
    return {
      lbl_4: n0full + '\n& ' + n1full + etAl,
      lbl_3: n0drop + '\n& ' + n1drop + etAl,
      lbl_2: n0init + '\n& ' + n1init + etAl,
      lbl_1: p0.last + etAl,
    };
  }

  function buildOwnerTiers(raw) {
    if (!raw || !raw.trim()) return { lbl_4:'', lbl_3:'', lbl_2:'', lbl_1:'' };
    var u    = raw.toUpperCase().trim();
    var type = _detectType(u);
    if (type === 'trust')     return _buildTrustTiers(u);
    if (type === 'corporate') return _buildEntityTiers(u);
    if (type === 'govt')      return _buildEntityTiers(u);
    return _buildPersonTiers(_splitParties(u).slice(0, 3));
  }

  // ── Geometry — pole of inaccessibility ───────────────────────────────────

  /** Ray-casting point-in-ring test. */
  function _inRing(x, y, ring) {
    var inside = false;
    for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      var xi = ring[i][0], yi = ring[i][1];
      var xj = ring[j][0], yj = ring[j][1];
      if (((yi > y) !== (yj > y)) &&
          (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) {
        inside = !inside;
      }
    }
    return inside;
  }

  /** Perpendicular distance from point (px,py) to segment (ax,ay)→(bx,by). */
  function _segDist(px, py, ax, ay, bx, by) {
    var dx = bx - ax, dy = by - ay;
    var len2 = dx * dx + dy * dy;
    if (len2 === 0) return Math.hypot(px - ax, py - ay);
    var t  = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  }

  /** Minimum distance from an interior point to the nearest ring edge. */
  function _distToEdge(x, y, ring) {
    var d = Infinity;
    for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      var s = _segDist(x, y, ring[j][0], ring[j][1], ring[i][0], ring[i][1]);
      if (s < d) d = s;
    }
    return d;
  }

  /** Point-in-polygon: inside the outer ring AND not inside any hole. */
  function _pointInPolygon(x, y, outer, holes) {
    if (!_inRing(x, y, outer)) return false;
    if (holes) {
      for (var i = 0; i < holes.length; i++) {
        if (_inRing(x, y, holes[i])) return false;
      }
    }
    return true;
  }

  /** Minimum distance from a point to the outer ring AND every hole boundary.
   *  Using the smallest of all these keeps the label from sitting right against
   *  the edge of any hole (in addition to the outer boundary). */
  function _distToAnyBoundary(x, y, outer, holes) {
    var d = _distToEdge(x, y, outer);
    if (holes) {
      for (var i = 0; i < holes.length; i++) {
        var hd = _distToEdge(x, y, holes[i]);
        if (hd < d) d = hd;
      }
    }
    return d;
  }

  /**
   * Pole of inaccessibility — grid search for the interior point
   * that is farthest from all edges ("meatiest" part of the polygon).
   * Honours holes: candidate points must be inside outer AND outside all holes,
   * and "edge distance" is measured to the nearest boundary of any ring.
   */
  function _polylabel(outer, holes) {
    var n = outer.length;
    if (n < 3) return [outer[0][0], outer[0][1]];

    var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (var i = 0; i < n; i++) {
      if (outer[i][0] < minX) minX = outer[i][0];
      if (outer[i][0] > maxX) maxX = outer[i][0];
      if (outer[i][1] < minY) minY = outer[i][1];
      if (outer[i][1] > maxY) maxY = outer[i][1];
    }

    var S    = POLYLABEL_STEPS;
    var stepX = (maxX - minX) / S;
    var stepY = (maxY - minY) / S;
    if (stepX === 0 || stepY === 0) return [(minX + maxX) / 2, (minY + maxY) / 2];

    var bestD = -Infinity, bestX = (minX + maxX) / 2, bestY = (minY + maxY) / 2;

    // Pass 1: coarse grid
    for (var xi = 0; xi < S; xi++) {
      for (var yi = 0; yi < S; yi++) {
        var cx = minX + (xi + 0.5) * stepX;
        var cy = minY + (yi + 0.5) * stepY;
        if (_pointInPolygon(cx, cy, outer, holes)) {
          var d = _distToAnyBoundary(cx, cy, outer, holes);
          if (d > bestD) { bestD = d; bestX = cx; bestY = cy; }
        }
      }
    }

    // Pass 2: refined grid (3× resolution) around best cell
    var rx = stepX, ry = stepY;
    var fineStepX = rx * 2 / S, fineStepY = ry * 2 / S;
    for (xi = 0; xi < S; xi++) {
      for (yi = 0; yi < S; yi++) {
        var fx = (bestX - rx) + (xi + 0.5) * fineStepX;
        var fy = (bestY - ry) + (yi + 0.5) * fineStepY;
        if (fx < minX || fx > maxX || fy < minY || fy > maxY) continue;
        if (_pointInPolygon(fx, fy, outer, holes)) {
          var fd = _distToAnyBoundary(fx, fy, outer, holes);
          if (fd > bestD) { bestD = fd; bestX = fx; bestY = fy; }
        }
      }
    }

    return [bestX, bestY];
  }

  /**
   * Projected extent of a W×H bounding box along a direction at `angleDeg`.
   * Approximates "how much space is available along this rotation axis".
   */
  function _extentAtAngle(W, H, angleDeg) {
    var r = angleDeg * Math.PI / 180;
    return Math.abs(W * Math.cos(r)) + Math.abs(H * Math.sin(r));
  }

  // ── Text measurement (DIC-520) ─────────────────────────────────────────────
  // Real glyph widths via canvas, so horizontal-fit decisions match what actually
  // renders — replaces the fixed PX_PER_CHAR proxy that over-estimated some names
  // and triggered premature wrap/rotate.
  var _mctx = (function () { try { return document.createElement('canvas').getContext('2d'); } catch (_) { return null; } })();
  function _fontStr(px) { return '700 ' + px + 'px "Noto Sans","Helvetica Neue",Arial,sans-serif'; }
  var _wCache = {};
  function _textW(str, px) {
    if (str == null || str === '') return 0;
    if (!_mctx) return String(str).length * px * 0.55;   // fallback ≈ avg advance
    var key = px + '|' + str;
    if (_wCache[key] != null) return _wCache[key];
    _mctx.font = _fontStr(px);
    var w = _mctx.measureText(str).width;
    _wCache[key] = w;
    return w;
  }
  var _avgCache = {};
  function _avgCharW(px) {
    if (_avgCache[px] != null) return _avgCache[px];
    var a = _textW('ABCDEFGHIJKLMNOPQRSTUVWXYZ', px) / 26;   // uppercase — owner names
    _avgCache[px] = a;
    return a;
  }

  // ── Geometry — minimum-area bounding rectangle (DIC-520) ───────────────────
  // Orientation from the min-area rect (convex hull + rotating calipers), in
  // screen-proportional coords. Robust to uneven vertex sampling (unlike PCA): an
  // axis-aligned rectangle returns 0°/90° no matter where its vertices sit, so
  // rectangular parcels never get spurious angled labels.
  function _convexHull(pts) {
    var p = pts.slice().sort(function (a, b) { return a[0] - b[0] || a[1] - b[1]; });
    if (p.length < 3) return p;
    var cross = function (o, a, b) { return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]); };
    var lower = [], i;
    for (i = 0; i < p.length; i++) {
      while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p[i]) <= 0) lower.pop();
      lower.push(p[i]);
    }
    var upper = [];
    for (i = p.length - 1; i >= 0; i--) {
      while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p[i]) <= 0) upper.pop();
      upper.push(p[i]);
    }
    lower.pop(); upper.pop();
    return lower.concat(upper);
  }
  // → { angleDeg: long-axis in text-rotate convention [-90,90], elongation: long/short }.
  function _minAreaRect(ring) {
    var pts = [], i;
    for (i = 0; i < ring.length; i++) pts.push([ring[i][0], ring[i][1] / LAT_FACTOR]);  // screen-proportional
    var hull = _convexHull(pts);
    if (hull.length < 3) return { angleDeg: 0, elongation: 1 };
    var best = Infinity, bestAng = 0, bestW = 1, bestH = 1;
    for (var h = 0; h < hull.length; h++) {
      var a = hull[h], b = hull[(h + 1) % hull.length];
      var ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
      var c = Math.cos(-ang), s = Math.sin(-ang);
      var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (var k = 0; k < hull.length; k++) {
        var rx = hull[k][0] * c - hull[k][1] * s, ry = hull[k][0] * s + hull[k][1] * c;
        if (rx < minX) minX = rx; if (rx > maxX) maxX = rx;
        if (ry < minY) minY = ry; if (ry > maxY) maxY = ry;
      }
      var w = maxX - minX, ht = maxY - minY, area = w * ht;
      if (area < best) { best = area; bestAng = ang; bestW = w; bestH = ht; }
    }
    var longAng = (bestW >= bestH) ? bestAng : bestAng + Math.PI / 2;
    var deg = -(longAng * 180 / Math.PI);   // screen y inverted vs north-up → negate
    while (deg > 90) deg -= 180;
    while (deg <= -90) deg += 180;
    var lo = Math.min(bestW, bestH), hi = Math.max(bestW, bestH);
    return { angleDeg: deg, elongation: hi / Math.max(lo, 1e-9) };
  }

  // ── Geometry — true polygon centroid (shoelace) ─────────────────────────

  /**
   * Area-weighted centroid of a polygon ring (signed shoelace formula).
   * For rectangular-ish parcels this is the visual centre, which beats
   * the pole-of-inaccessibility for aesthetic placement.
   */
  function _polyCentroid(ring) {
    var cx = 0, cy = 0, a2 = 0;
    for (var i = 0; i < ring.length - 1; i++) {
      var x0 = ring[i][0],     y0 = ring[i][1];
      var x1 = ring[i + 1][0], y1 = ring[i + 1][1];
      var cross = x0 * y1 - x1 * y0;
      cx += (x0 + x1) * cross;
      cy += (y0 + y1) * cross;
      a2 += cross;
    }
    if (Math.abs(a2) < 1e-12) return null;
    return [cx / (3 * a2), cy / (3 * a2)];
  }

  // ── Geometry — bbox dimensions ────────────────────────────────────────────

  /** Returns { w, h, ratio } for a polygon ring. */
  function _bboxDims(ring) {
    var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (var i = 0; i < ring.length; i++) {
      if (ring[i][0] < minX) minX = ring[i][0];
      if (ring[i][0] > maxX) maxX = ring[i][0];
      if (ring[i][1] < minY) minY = ring[i][1];
      if (ring[i][1] > maxY) maxY = ring[i][1];
    }
    var w = Math.max(0.0001, maxX - minX);   // longitude extent (degrees)
    var h = Math.max(0.0001, maxY - minY);   // latitude extent (degrees)
    var bboxA = w * h;
    var polyA = 0;
    for (var j = 0; j < ring.length - 1; j++) {
      polyA += ring[j][0] * ring[j + 1][1] - ring[j + 1][0] * ring[j][1];
    }
    var ratio = Math.min(1, Math.abs(polyA) / 2 / bboxA);
    return { w: w, h: h, ratio: ratio };
  }

  /** Signed shoelace area of a ring (sign indicates winding direction). */
  function _ringArea(ring) {
    var a = 0;
    for (var i = 0; i < ring.length - 1; i++) {
      a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
    }
    return a / 2;
  }

  /**
   * Returns the dominant polygon of a feature as { outer, holes }.
   *   - Polygon       → outer = coordinates[0], holes = coordinates[1..]
   *   - MultiPolygon  → pick the polygon with the largest outer-ring area,
   *                     then return its outer ring + its holes
   * Holes are honoured downstream so labels never land in cut-outs.
   */
  function _outerAndHoles(feature) {
    var g = feature.geometry;
    if (!g) return { outer: [], holes: [] };

    if (g.type === 'Polygon') {
      var rings = g.coordinates || [];
      return { outer: rings[0] || [], holes: rings.slice(1) };
    }

    if (g.type === 'MultiPolygon') {
      var polys = g.coordinates;
      if (!polys || !polys.length) return { outer: [], holes: [] };
      var bestPoly = null, bestArea = -1;
      for (var i = 0; i < polys.length; i++) {
        var outer = polys[i] && polys[i][0];
        if (!outer || outer.length < 3) continue;
        var a = Math.abs(_ringArea(outer));
        if (a > bestArea) { bestArea = a; bestPoly = polys[i]; }
      }
      bestPoly = bestPoly || polys[0] || [];
      return { outer: bestPoly[0] || [], holes: bestPoly.slice(1) };
    }

    return { outer: [], holes: [] };
  }

  // ── Per-parcel font scale ─────────────────────────────────────────────────

  /**
   * Scale multiplier based on parcel size in acres.
   * NARROW band (DIC-521): the priority is label *content*, not size. A tight
   * 0.88–1.25 spread (≈1.4×, vs the old 2.9×) keeps type fairly uniform AND lets
   * more text fit on big parcels (smaller font ⇒ more chars per line ⇒ fuller
   * plat-book labels). Acres is now reliable (geodesic, server-side), so the
   * size cue is honest but gentle.
   *   medium base (10px): 8.8 px (tiny lot) → 12.5 px (big farm)
   */
  function _fontScale(acres) {
    if (!acres || acres <= 0) return 1.00;  // unknown ⇒ neutral (no size penalty)
    if (acres > 200) return 1.25;
    if (acres > 100) return 1.20;
    if (acres >  40) return 1.15;
    if (acres >  10) return 1.05;
    if (acres >   2) return 1.00;
    if (acres > 0.5) return 0.94;
    return 0.88;
  }

  // ── Longest line in a (possibly multi-line) label string ─────────────────

  function _longestLine(s) {
    if (!s) return '';
    return s.split('\n').reduce(function (a, b) {
      return a.length >= b.length ? a : b;
    }, '');
  }

  /**
   * Smart word-wrap: break near the middle of a string (2 lines), or near
   * 1/3 and 2/3 (3 lines), or 1/4 · 1/2 · 3/4 (4 lines).
   * This mirrors plat-book practice — balanced, centred line stacks —
   * rather than greedy left-to-right packing.
   *
   * Respects existing \n (couple / entity breaks) as hard paragraph dividers;
   * each paragraph is wrapped independently.
   *
   * Returns an array of line strings (join with '\n' to store on feature).
   */
  function _smartWrap(text, maxCharsPerLine, maxLinesOverride) {
    if (!text) return [''];
    var MAX = Math.max(3, maxCharsPerLine);
    var lineCap = maxLinesOverride || MAX_WRAP_LINES;
    var paras = text.split('\n');
    var result = [];

    for (var p = 0; p < paras.length; p++) {
      // Split only on regular space/tab — NBSP ( ) deliberately preserved
      // so phrases like "(120 ac)" or other quoted-together text never break.
      var words = paras[p].split(/[ \t]+/).filter(Boolean);
      if (!words.length) continue;

      // Single word or fits on one line — no split
      var paraStr = words.join(' ');
      if (words.length === 1 || paraStr.length <= MAX) {
        result.push(paraStr);
        continue;
      }

      // Cumulative char lengths at each word boundary
      var cum = [0];
      for (var i = 0; i < words.length; i++) {
        cum.push(cum[i] + words[i].length + (i < words.length - 1 ? 1 : 0));
      }
      var total = cum[words.length];

      // How many lines do we need?
      var nLines = Math.min(lineCap, Math.max(2, Math.ceil(total / MAX)));

      // Find break-word indices nearest the ideal fractional positions
      var breaks = [];
      for (var b = 1; b < nLines; b++) {
        var ideal = total * b / nLines;
        var best = 1, bestDist = Infinity;
        for (var j = 1; j < words.length; j++) {
          if (breaks.indexOf(j) !== -1) continue;
          var d = Math.abs(cum[j] - ideal);
          if (d < bestDist) { bestDist = d; best = j; }
        }
        breaks.push(best);
      }
      breaks.sort(function (a, b) { return a - b; });

      var prev = 0;
      for (var k = 0; k < breaks.length; k++) {
        var seg = words.slice(prev, breaks[k]).join(' ');
        if (seg) result.push(seg);
        prev = breaks[k];
      }
      var tail = words.slice(prev).join(' ');
      if (tail) result.push(tail);
    }

    return result.length ? result : [text];
  }

  /** Format acreage for the parenthetical second-line annotation.
   *  Uses U+00A0 (non-breaking space) so _smartWrap never breaks inside the parens. */
  function _formatAcresLine(acres) {
    if (!acres || acres <= 0) return '';
    var n = acres >= 10 ? Math.round(acres)
          : acres >= 1  ? acres.toFixed(1)
          :               acres.toFixed(2);
    // U+00A0 (non-breaking space) between number and "ac" so the parens stay intact
    return '(' + n + ' ac)';
  }

  /**
   * Format a PIN/parcel number with breakable spaces after digits 3, 6, 9.
   *   "01234567890"  →  "012 345 678 90"
   * _smartWrap can later use those spaces as natural line-break points.
   */
  function _formatPin(raw) {
    if (!raw) return '';
    var s = String(raw).replace(/\s+/g, '');
    if (s.length <= 3) return s;
    var out = s.substring(0, 3);
    if (s.length > 3) out += ' ' + s.substring(3, 6);
    if (s.length > 6) out += ' ' + s.substring(6, 9);
    if (s.length > 9) out += ' ' + s.substring(9);
    return out;
  }

  /** Size of a pre-wrapped line array — used for fit checks. Width is the widest
   *  line's REAL measured pixel width at fontPx (DIC-520), not a char-count proxy. */
  function _wrapSize(lines, lineHeightPx, fontPx) {
    var widthPx = 0;
    for (var i = 0; i < lines.length; i++) {
      var w = _textW(lines[i], fontPx);
      if (w > widthPx) widthPx = w;
    }
    return {
      widthPx:  widthPx,
      heightPx: lines.length * lineHeightPx,
      lines:    lines.length,
    };
  }

  // ── Centroid GeoJSON builder ──────────────────────────────────────────────

  function buildCentroids(parcelIndex) {
    var features = [];

    for (var i = 0; i < parcelIndex.length; i++) {
      var feat = parcelIndex[i];
      var p    = feat.properties || {};
      var geom = _outerAndHoles(feat);
      var ring = geom.outer;
      var holes = geom.holes;
      if (ring.length < 3) continue;

      // Geometry analysis (bbox & ratio based on outer ring — holes don't shrink the bbox)
      var dims   = _bboxDims(ring);
      var ratio  = dims.ratio;
      var bboxW  = dims.w;   // east-west longitude extent (degrees)
      var bboxH  = dims.h;   // north-south latitude extent (degrees)

      // Label anchor:
      //  - Rectangular parcel (ratio ≥ 0.70) AND centroid not in a hole → centroid
      //  - Otherwise → pole of inaccessibility (hole-aware)
      // The hole check is critical for donut-shaped parcels (parcel-around-a-cutout).
      var pt;
      if (ratio >= 0.70) {
        var cent = _polyCentroid(ring);
        pt = (cent && _pointInPolygon(cent[0], cent[1], ring, holes))
          ? cent
          : _polylabel(ring, holes);
      } else {
        pt = _polylabel(ring, holes);
      }
      var pin = p.pin || p.PIN || '';

      // Owner tiers
      var ownerRaw = p.owner_name || p.OWNERNAME || '';
      var tiers    = buildOwnerTiers(ownerRaw);

      // Parcel orientation from the minimum-area bounding rectangle (DIC-520):
      // robust to vertex density, so axis-aligned rectangles read as 0°/90° and
      // only genuinely diagonal, elongated parcels get an angled label (Phase 3).
      var orient    = _minAreaRect(ring);
      var rectAngle = orient.angleDeg;
      var elong     = orient.elongation;

      // Pre-formatted non-owner text (for per-zoom wrapping below).
      // PIN: spaces inserted at digits 3/6/9 so smart-wrap can break there naturally.
      // Address: kept as-is; smart-wrap will break at word boundaries.
      var pinFormatted  = _formatPin(pin);
      var addrFormatted = String(p.PCOMBINED || '');

      // Font scale from acres
      var acres  = p.gis_acres != null ? parseFloat(p.gis_acres)
                 : p.GIS_Acres != null ? parseFloat(p.GIS_Acres) : null;
      var scale  = _fontScale(acres);
      var fsProps = {
        _fs_s: Math.round(FONT_SIZES.small  * scale * 10) / 10,
        _fs_m: Math.round(FONT_SIZES.medium * scale * 10) / 10,
        _fs_l: Math.round(FONT_SIZES.large  * scale * 10) / 10,
      };

      // ── Per-zoom: select the BEST TIER + ANGLE for this parcel at this zoom.
      //
      // Algorithm (plat-book convention; fit uses REAL measured text — DIC-520):
      //   Phase 1 — each tier highest→lowest at 0° (horizontal), smart-wrapped;
      //             first whose measured block fits E-W and N-S wins.
      //   Phase 2 — if none fit at 0°, tiers 1–2 at -90° (vertical).
      //   Phase 3 — along the parcel's long axis, ONLY for genuinely diagonal,
      //             elongated parcels (min-area-rect orientation + elongation gate).
      //   Phase 4 — force tier 1 at whichever cardinal axis is longer (never angled).
      //
      // Pixel math (Mercator at ~42°N):
      //   horizPx = bboxW × pxPerDeg          (lon degrees → px; uniform in Mercator)
      //   vertPx  = bboxH × pxPerDeg / LAT_FACTOR  (lat degrees are LONGER poleward)

      // Always start at tier 4 — let the fit check reduce as needed.
      // The ratio-based cap was suppressing useful info; the smart-wrap fit
      // check is a better signal of whether the longest label actually fits.
      var maxTier = 4;

      // Line height + font size in screen pixels (medium-size font for this parcel).
      var lineHeightPx = FONT_SIZES.medium * scale * LINE_HEIGHT_FAC;
      var fontPx       = FONT_SIZES.medium * scale;   // for real text measurement (DIC-520)

      var zProps = {}, aProps = {};
      for (var z = 13; z <= 17; z++) {
        var pxPerDeg = (256 * Math.pow(2, z)) / 360;
        var horizPx  = bboxW * pxPerDeg;
        var vertPx   = bboxH * pxPerDeg / LAT_FACTOR;

        var label = '', angle = 0;

        // maxCharsPerLine: how many chars fit across the parcel width, from the
        // REAL average glyph width at this font size (DIC-520).
        var maxCPL = Math.max(3, Math.floor((horizPx * HORIZ_PAD) / _avgCharW(fontPx)));
        var acresLine = _formatAcresLine(acres);

        // ── Phase 1: Highest tier that fits at 0° with smart wrapping ────────
        // For each tier, try WITH acres appended first (max info), then without.
        for (var t = maxTier; t >= 1; t--) {
          var cand = tiers['lbl_' + t] || '';
          if (!cand) continue;

          // Try with acres line appended
          if (acresLine) {
            var withAc = cand + '\n' + acresLine;
            var lA = _smartWrap(withAc, maxCPL);
            var szA = _wrapSize(lA, lineHeightPx, fontPx);
            if (szA.lines <= MAX_WRAP_LINES + 1 &&    // allow 1 extra line for acres
                szA.widthPx  <= horizPx &&
                szA.heightPx <= vertPx * VERT_PAD) {
              label = lA.join('\n'); angle = 0; break;
            }
          }

          // Fallback: without acres
          var l0 = _smartWrap(cand, maxCPL);
          var sz0 = _wrapSize(l0, lineHeightPx, fontPx);
          if (sz0.lines <= MAX_WRAP_LINES &&
              sz0.widthPx  <= horizPx &&
              sz0.heightPx <= vertPx * VERT_PAD) {
            label = l0.join('\n'); angle = 0; break;
          }
        }

        // ── Phase 2: Try tiers 1–2 at -90° (vertical, bottom-to-top) ───────
        if (!label) {
          var t90max = Math.min(maxTier, 2);
          for (var t2 = t90max; t2 >= 1; t2--) {
            var cand2 = tiers['lbl_' + t2] || '';
            if (!cand2) continue;
            // At -90°: text length runs N-S; each line height consumes E-W space
            var lines2raw = cand2.split('\n');
            if (_textW(_longestLine(cand2), fontPx) <= vertPx * HORIZ_PAD &&
                lines2raw.length * lineHeightPx <= horizPx * VERT_PAD) {
              label = cand2; angle = -90; break;
            }
          }
        }

        // ── Phase 3: Along the parcel's long axis — ONLY for genuinely diagonal,
        //   elongated parcels (DIC-520). Min-area-rect orientation must be clearly
        //   off-cardinal (12°–78°) AND the parcel elongated (long/short ≥ 1.4), so
        //   axis-aligned rectangles never get an angled label. (No blind 45°.)
        if (!label && Math.abs(rectAngle) >= 12 && Math.abs(rectAngle) <= 78 && elong >= 1.4) {
          var widthAlong = _extentAtAngle(horizPx, vertPx, rectAngle);
          var heightPerp = _extentAtAngle(horizPx, vertPx, rectAngle + 90);
          for (var t3 = Math.min(maxTier, 2); t3 >= 1; t3--) {
            var cand3 = tiers['lbl_' + t3] || '';
            if (!cand3) continue;
            var n3 = cand3.split('\n').length;
            if (_textW(_longestLine(cand3), fontPx) <= widthAlong * HORIZ_PAD &&
                n3 * lineHeightPx <= heightPerp * VERT_PAD) {
              label = cand3; angle = rectAngle; break;
            }
          }
        }

        // ── Phase 4: Force-show tier 1 (last name only) at whichever axis is longest.
        //   MapLibre's text-allow-overlap:false will cull it if it truly can't
        //   fit alongside higher-priority labels.  Better to try than suppress.
        if (!label) {
          var forced = tiers['lbl_1'] || tiers['lbl_2'] || '';
          if (forced) {
            label = forced;
            angle = (vertPx > horizPx) ? -90 : 0;
          }
        }

        // Store the chosen label + angle for this zoom ('' if nothing fit).
        zProps['_z' + z] = label;
        aProps['_a' + z] = angle;

        // Per-zoom wrapped versions of non-owner multi-token fields.
        // PINs are space-separated at digits 3/6/9 so they break naturally.
        // Addresses break at word boundaries via _smartWrap.
        if (pinFormatted) {
          // PINs cap at 2 lines — more is unreadable as a numeric identifier
          zProps['_pin_z' + z] = _smartWrap(pinFormatted, maxCPL, 2).join('\n');
        } else {
          zProps['_pin_z' + z] = '';
        }
        if (addrFormatted) {
          zProps['_addr_z' + z] = _smartWrap(addrFormatted, maxCPL).join('\n');
        } else {
          zProps['_addr_z' + z] = '';
        }
      }

      // Non-owner pre-formatted fields
      var numProps = {
        _pin:      _fmtField(p, 'pin'),
        _address:  _fmtField(p, 'address'),
        _acresLbl: _fmtField(p, 'acres'),   // display string — _acres (numeric) is reserved for filters
        _av:       _fmtField(p, 'av'),
        _sev:      _fmtField(p, 'sev'),
        _tv:       _fmtField(p, 'tv'),
        _tmv:      _fmtField(p, 'tmv'),
        _tmv_acre: _fmtField(p, 'tmv_acre'),
        _zoning:   _fmtField(p, 'zoning'),
        _class:    _fmtField(p, 'class'),
      };

      // _acres stored as a number so MapLibre filter expressions can compare it
      var props = { _pin: pin, _acres: acres || 0 };
      var k;
      for (k in zProps) { if (zProps.hasOwnProperty(k)) props[k] = zProps[k]; }
      for (k in aProps) { if (aProps.hasOwnProperty(k)) props[k] = aProps[k]; }
      for (k in fsProps){ if (fsProps.hasOwnProperty(k)) props[k] = fsProps[k]; }
      for (k in numProps){ if (numProps.hasOwnProperty(k)) props[k] = numProps[k]; }

      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: pt },
        properties: props,
      });
    }

    return { type: 'FeatureCollection', features: features };
  }

  // ── Non-owner field formatting ────────────────────────────────────────────

  function _fmtField(p, field) {
    var acres = p.gis_acres != null ? parseFloat(p.gis_acres) : null;
    var av    = p.assessed_value_2026 != null ? parseInt(p.assessed_value_2026) : null;
    var sev   = p.sev_2026            != null ? parseInt(p.sev_2026)            : null;
    var tv    = p.taxable_value_2026  != null ? parseInt(p.taxable_value_2026)  : null;
    var tmv   = av != null ? av * 2 : null;
    var cur   = function (v) { return v != null ? '$' + v.toLocaleString() : ''; };
    switch (field) {
      case 'pin':      return String(p.pin || p.PIN || '');
      case 'address':  return String(p.PCOMBINED || '');
      case 'acres':    return acres != null ? acres.toFixed(2) + ' ac' : '';
      case 'av':       return cur(av);
      case 'sev':      return cur(sev);
      case 'tv':       return cur(tv);
      case 'tmv':      return cur(tmv);
      case 'tmv_acre': return (tmv != null && acres != null && acres > 0)
                         ? '$' + Math.round(tmv / acres).toLocaleString() + '/ac' : '';
      case 'zoning':   return String(p.zoning || p.Zoning || '');
      case 'class':    return String(p.prop_class || p.PRTYCLASS || '');
      default:         return '';
    }
  }

  // ── MapLibre layer management ─────────────────────────────────────────────

  function getMap() { return window.PS_MAP || null; }
  // A3 (DIC-568): the viewport parcel index via the injected context, global as fallback.
  function sourceIndex() { return (window.PS_CONTEXT && window.PS_CONTEXT.sourceIndex) || window.PS_PARCEL_INDEX || null; }

  // ── Background-aware label paint (DIC-519) ─────────────────────────────────
  // Labels sit over the basemap (the parcel wash is mostly transparent), so the
  // basemap brightness decides readable text. Effective dark background = dark
  // theme OR aerial imagery on → white text + dark halo (the original scheme).
  // Light basemap → dark text + cream halo. Halos stay on either way (AA).
  function _darkBackground() {
    try {
      if (document.documentElement.getAttribute('data-theme') === 'dark') return true;
      var aerial = document.getElementById('toggle-aerial');
      if (aerial && aerial.checked) return true;
    } catch (_) {}
    return false;
  }
  function _labelPaint() {
    return _darkBackground()
      ? { 'text-color': '#ffffff', 'text-halo-color': '#1a1a2e', 'text-halo-width': 1.5, 'text-halo-blur': 0.5 }
      : { 'text-color': '#1f2937', 'text-halo-color': '#fbf7ec', 'text-halo-width': 1.6, 'text-halo-blur': 0.3 };
  }
  function _repaintLabels() {
    var map = getMap();
    if (!map) return;
    var p = _labelPaint();
    _LAYER_DEFS.forEach(function (def) {
      if (!_layersAdded[def.id] || !map.getLayer(def.id)) return;
      Object.keys(p).forEach(function (k) { try { map.setPaintProperty(def.id, k, p[k]); } catch (_) {} });
    });
  }

  function _textFieldExpr(field) {
    // Multi-token fields are pre-wrapped per zoom (owner / pin / address).
    // Single-token fields (AV, SEV, acres, zoning, class) need no wrapping.
    if (field === 'owner') {
      return ['step', ['zoom'], '',
        13, ['get', '_z13'],   14, ['get', '_z14'],
        15, ['get', '_z15'],   16, ['get', '_z16'],
        17, ['get', '_z17'],
      ];
    }
    if (field === 'pin') {
      return ['step', ['zoom'], '',
        13, ['get', '_pin_z13'],  14, ['get', '_pin_z14'],
        15, ['get', '_pin_z15'],  16, ['get', '_pin_z16'],
        17, ['get', '_pin_z17'],
      ];
    }
    if (field === 'address') {
      return ['step', ['zoom'], '',
        13, ['get', '_addr_z13'], 14, ['get', '_addr_z14'],
        15, ['get', '_addr_z15'], 16, ['get', '_addr_z16'],
        17, ['get', '_addr_z17'],
      ];
    }
    var prop = field === 'tmv_acre' ? '_tmv_acre'
             : field === 'acres'   ? '_acresLbl'
             : '_' + field;
    return ['step', ['zoom'], '', MIN_ZOOM, ['get', prop]];
  }

  function _rotateExpr() {
    // Zoom-stepped expression using pre-computed per-zoom angles
    return ['step', ['zoom'], 0,
      13, ['get', '_a13'],
      14, ['get', '_a14'],
      15, ['get', '_a15'],
      16, ['get', '_a16'],
      17, ['get', '_a17'],
    ];
  }

  function _sizeExpr() {
    // Narrower, plat-book-accurate range — pre-interpolated so larger parcels
    // get visibly bigger text without anything becoming illegibly small or huge.
    //   0.1 ac → 8–10px  |  5 ac → 10–12px  |  40 ac → 13–16px  |  200 ac → 16–20px
    var mul = _size === 'small' ? 0.85 : _size === 'large' ? 1.20 : 1.00;
    return [
      'interpolate', ['linear'], ['coalesce', ['get', '_acres'], 0],
      0,    8.5 * mul,
      0.5,  9   * mul,
      2,    10  * mul,
      10,   11  * mul,
      40,   13  * mul,
      100,  15  * mul,
      200,  16.5 * mul,
      500,  18  * mul
    ];
  }

  function addOrUpdateLayer() {
    var map = getMap();
    if (!map || !_computed) return;

    if (!_sourceAdded) {
      map.addSource(SOURCE_ID, { type: 'geojson', data: _computed });
      _sourceAdded = true;
    }

    // Add or update each of the three priority layers.
    // Order matters: XL is added first → gets first collision-detection pass
    // → large farm labels always win conflicts with smaller parcels.
    var before = map.getLayer('annotation-fill') ? 'annotation-fill' : undefined;

    _LAYER_DEFS.forEach(function (def) {
      if (!_layersAdded[def.id]) {
        try { map.addLayer({
          id:      def.id,
          type:    'symbol',
          source:  SOURCE_ID,
          minzoom: def.minzoom,
          filter:  def.filter,
          layout: {
            'text-field':              _textFieldExpr(_field),
            'text-font':               ['Noto Sans Bold'],
            'text-rotate':             _rotateExpr(),
            'text-rotation-alignment': 'map',
            'text-allow-overlap':      false,
            'text-ignore-placement':   false,
            'text-max-width':          50,   // we pre-wrap with \n — disable MapLibre auto-wrap
            'text-size':               _sizeExpr(),
            'text-anchor':             'center',
            'symbol-placement':        'point',
            'symbol-avoid-edges':      true,
            'symbol-sort-key':         ['-', 0, ['coalesce', ['get', '_acres'], 0]],
          },
          paint: _labelPaint(),
        }, before);
        _layersAdded[def.id] = true;
        } catch (err) { console.error('[parcel-labels] addLayer failed for', def.id, err); }

      } else {
        map.setLayoutProperty(def.id, 'text-field',  _textFieldExpr(_field));
        map.setLayoutProperty(def.id, 'text-rotate', _rotateExpr());
        map.setLayoutProperty(def.id, 'text-size',   _sizeExpr());
      }
    });
    _repaintLabels();   // match the current background (theme / aerial)
  }

  // ── Public actions ────────────────────────────────────────────────────────

  function activate() {
    var parcelIndex = sourceIndex();
    if (!parcelIndex || !parcelIndex.length || !getMap()) {
      setTimeout(activate, 400);
      return;
    }
    // Always rebuild from the CURRENT index (not a stale cache) so turning labels on
    // reflects wherever the map is now — e.g. after panning with labels off.
    _computed = buildCentroids(parcelIndex);
    _active = true;
    addOrUpdateLayer();
    var map = getMap();
    _LAYER_DEFS.forEach(function (def) {
      if (map && _layersAdded[def.id]) map.setLayoutProperty(def.id, 'visibility', 'visible');
    });
    _saveState();
  }

  function deactivate() {
    _active = false;
    var map = getMap();
    _LAYER_DEFS.forEach(function (def) {
      if (map && _layersAdded[def.id]) map.setLayoutProperty(def.id, 'visibility', 'none');
    });
    _saveState();
  }

  // Rebuild the labels for the parcels now in view. Labels are computed from
  // PS_PARCEL_INDEX, which map.js re-fetches per viewport bbox and announces via
  // 'ps:parcel-index-updated'. Without recomputing here, labels only ever covered the
  // parcels loaded when the tool was switched on — so panning showed no labels in the
  // newly-revealed area. Gated to active + label zoom, so it does no work when off.
  function rebuildFromIndex() {
    if (!_active) return;
    var map = getMap();
    if (!map || map.getZoom() < MIN_ZOOM) return;
    var idx = sourceIndex();
    if (!idx || !idx.length) return;
    _computed = buildCentroids(idx);
    var src = map.getSource(SOURCE_ID);
    if (src && src.setData) src.setData(_computed);
    else addOrUpdateLayer();
  }

  function setField(field) {
    _field = field;
    if (_active) {
      var map = getMap();
      _LAYER_DEFS.forEach(function (def) {
        if (map && _layersAdded[def.id])
          map.setLayoutProperty(def.id, 'text-field', _textFieldExpr(field));
      });
    }
    _saveState();
  }

  function setSize(size) {
    _size = size;
    if (_active) {
      var map = getMap();
      _LAYER_DEFS.forEach(function (def) {
        if (map && _layersAdded[def.id])
          map.setLayoutProperty(def.id, 'text-size', _sizeExpr());
      });
    }
    _saveState();
  }

  // ── Persistence ───────────────────────────────────────────────────────────

  var _LS_KEY = 'parcel_labels_state';

  function _saveState() {
    try {
      localStorage.setItem(_LS_KEY, JSON.stringify({
        active: _active, field: _field, size: _size,
      }));
    } catch (_) {}
  }

  function _loadState() {
    try {
      var s = JSON.parse(localStorage.getItem(_LS_KEY) || 'null');
      if (!s) return;
      _active = !!s.active;
      _field  = s.field  || 'owner';
      _size   = s.size   || 'medium';
    } catch (_) {}
  }

  // ── UI wiring ─────────────────────────────────────────────────────────────

  function _wireUI() {
    var toggle   = document.getElementById('plbl-toggle');
    var fieldSel = document.getElementById('plbl-field');
    var controls = document.getElementById('plbl-controls');
    var sizeBtns = document.querySelectorAll('.plbl-size-btn');

    function _syncControls(on) {
      if (controls) controls.style.display = on ? '' : 'none';
    }

    if (toggle) {
      toggle.checked = _active;
      _syncControls(_active);
      toggle.addEventListener('change', function () {
        _syncControls(this.checked);
        if (this.checked) { activate(); } else { deactivate(); }
      });
    }
    if (fieldSel) {
      fieldSel.value = _field;
      fieldSel.addEventListener('change', function () { setField(this.value); });
    }
    sizeBtns.forEach(function (btn) {
      btn.classList.toggle('active', btn.dataset.size === _size);
      btn.addEventListener('click', function () {
        sizeBtns.forEach(function (b) { b.classList.remove('active'); });
        this.classList.add('active');
        setSize(this.dataset.size);
      });
    });
  }

  // ── Init ──────────────────────────────────────────────────────────────────

  _loadState();
  _wireUI();

  // Re-color labels when the background changes (DIC-519): theme toggle (data-theme)
  // and the aerial-imagery toggle both flip the effective background brightness.
  try {
    new MutationObserver(_repaintLabels).observe(document.documentElement,
      { attributes: true, attributeFilter: ['data-theme'] });
  } catch (_) {}
  document.addEventListener('change', function (e) {
    if (e.target && e.target.id === 'toggle-aerial') _repaintLabels();
  });

  // Re-label the new viewport whenever the parcel index refreshes (pan/zoom). map.js
  // fires this after fetching /parcels?bbox= for the current view (see refreshParcelIndex).
  document.addEventListener('ps:parcel-index-updated', rebuildFromIndex);

  if (_active) {
    var _tryActivate = function () {
      if (window.PS_MAP && sourceIndex()) { activate(); }
      else { setTimeout(_tryActivate, 300); }
    };
    _tryActivate();
  }

  // ── Export ────────────────────────────────────────────────────────────────

  window.PS_PARCEL_LABELS = {
    activate:   activate,
    deactivate: deactivate,
    setField:   setField,
    setSize:    setSize,
  };

}());
