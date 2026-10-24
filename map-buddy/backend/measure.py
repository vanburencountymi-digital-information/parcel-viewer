"""Measurements Map Buddy can read back (DIC-2434).

The browser measures with Turf and shows the result in a bubble; the model used to get
only "shown to the user". These functions do the same math on the server so the tool
result carries the numbers. They copy Turf 7's formulas (spherical ring area, haversine,
the same earth radius and unit factors), so what the model says matches the bubble.
"""

import math
from typing import Any

# @turf/helpers: earthRadius and the unit conversions the browser code uses.
EARTH_RADIUS_M = 6371008.8
_SQFT_PER_SQM = 10.7639  # map-control-api.js
_FT_PER_M = 3.28084
_FT_PER_MILE = 5280
_SQFT_PER_ACRE = 43560
_RAD = math.pi / 180

# Model-supplied shapes are bounded so a tool call can't make us loop on huge input.
MAX_POINTS = 2000


def _ring_area_sqm(ring: list) -> float:
    """@turf/area ringArea: signed spherical area of a closed ring, in m²."""
    n = len(ring) - 1
    if n <= 2:
        return 0.0
    total = 0.0
    for i in range(n):
        lower = ring[i]
        middle = ring[0 if i + 1 == n else i + 1]
        upper = ring[(i + 2) % n if i + 2 >= n else i + 2]
        total += (upper[0] * _RAD - lower[0] * _RAD) * math.sin(middle[1] * _RAD)
    return total * EARTH_RADIUS_M * EARTH_RADIUS_M / 2


def _polygon_area_sqm(rings: list) -> float:
    if not rings:
        return 0.0
    return abs(_ring_area_sqm(rings[0])) - sum(abs(_ring_area_sqm(r)) for r in rings[1:])


def distance_m(a: list, b: list) -> float:
    """@turf/distance: haversine distance between two [lng, lat] points, in metres."""
    d_lat = (b[1] - a[1]) * _RAD
    d_lon = (b[0] - a[0]) * _RAD
    h = math.sin(d_lat / 2) ** 2 + math.sin(d_lon / 2) ** 2 * math.cos(a[1] * _RAD) * math.cos(
        b[1] * _RAD
    )
    return 2 * math.atan2(math.sqrt(h), math.sqrt(1 - h)) * EARTH_RADIUS_M


def _path_m(coords: list) -> float:
    return sum(distance_m(coords[i], coords[i + 1]) for i in range(len(coords) - 1))


def _close(ring: list) -> list:
    return ring if ring[0] == ring[-1] else ring + [ring[0]]


def clean_points(raw: Any) -> list | None:
    """Model input → [[lng, lat], ...] of finite, in-range numbers, or None if unusable."""
    if not isinstance(raw, list) or len(raw) > MAX_POINTS:
        return None
    out = []
    for p in raw:
        if isinstance(p, dict):
            p = [p.get("lng", p.get("lon")), p.get("lat")]
        if not isinstance(p, (list, tuple)) or len(p) < 2:
            return None
        lng, lat = p[0], p[1]
        if any(isinstance(v, bool) or not isinstance(v, (int, float)) for v in (lng, lat)):
            return None
        if not (math.isfinite(lng) and math.isfinite(lat)):
            return None
        if not (-180 <= lng <= 180 and -90 <= lat <= 90):
            return None
        out.append([float(lng), float(lat)])
    return out


def _bbox(polygons: list) -> tuple[float, float, float, float]:
    pts = [pt for rings in polygons for ring in rings for pt in ring]
    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    return min(xs), min(ys), max(xs), max(ys)


def _summarise(polygons: list) -> dict:
    """Area, perimeter and bbox dimensions for a list of polygons (each a list of rings),
    matching quickParcelInfo / measureArea in map-control-api.js."""
    sqft = sum(_polygon_area_sqm(rings) for rings in polygons) * _SQFT_PER_SQM
    perim_ft = sum(_path_m(ring) for rings in polygons for ring in rings) * _FT_PER_M
    w, s, e, n = _bbox(polygons)
    est_w = distance_m([w, s], [e, s]) * _FT_PER_M
    est_h = distance_m([w, s], [w, n]) * _FT_PER_M
    return {
        "acres": round(sqft / _SQFT_PER_ACRE, 3),
        "sqft": round(sqft),
        "perimeter_ft": round(perim_ft),
        "est_dim_long_ft": round(max(est_w, est_h)),
        "est_dim_short_ft": round(min(est_w, est_h)),
    }


def measure_area(coords: list) -> dict:
    """Takes a polygon's outer ring (auto-closed). Returns acres, ft², perimeter, dims."""
    return _summarise([[_close(coords)]])


def measure_distance(coords: list) -> dict:
    """Takes path waypoints. Returns total and per-segment lengths in feet."""
    segs = [distance_m(coords[i], coords[i + 1]) * _FT_PER_M for i in range(len(coords) - 1)]
    total = sum(segs)
    return {
        "total_ft": round(total),
        "total_mi": round(total / _FT_PER_MILE, 2),
        "segments": len(segs),
        "longest_segment_ft": round(max(segs)),
        "shortest_segment_ft": round(min(segs)),
    }


def measure_geometry(geom: dict | None) -> dict | None:
    """Takes a GeoJSON Polygon or MultiPolygon in lng/lat. Returns measure_area's fields."""
    if not isinstance(geom, dict):
        return None
    if geom.get("type") == "Polygon":
        polygons = [geom.get("coordinates") or []]
    elif geom.get("type") == "MultiPolygon":
        polygons = geom.get("coordinates") or []
    else:
        return None
    polygons = [rings for rings in polygons if rings and rings[0]]
    if not polygons:
        return None
    return _summarise(polygons)
