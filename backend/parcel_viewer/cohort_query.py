"""cohort_query.py — pure cohort-selector → SQL predicate builder (DIC-587).

The /cohort route resolves a cohort SELECTOR to a feature SET; the deterministic
AGGREGATION then runs in the engine core (engine/capabilities/cohort-analyze.core.js) —
single source of truth, no SQL/JS drift. This module is the spatial-selection half:
selector dict → (WHERE predicate, params, resolved-selector). It has NO DB imports, so the
harness unit-tests the selector logic + validation with no database.

Selectors (v1):
  - explicit        : { type:'explicit', ids:[int, ...] }                        → pg.id = ANY()
  - buffer          : { type:'buffer', parcel_id:int, distance_ft:float }        → ST_DWithin (around a parcel)
                      { type:'buffer', lng:float, lat:float, distance_ft:float } → ST_DWithin (around a point)
  - named-geography : { type:'named-geography', geography:'subdivision'|'section'|'township'|'school', id?|name? }
                        subdivision / section → SPATIAL (ST_Intersects a geo.* polygon)
                        township / school     → ATTRIBUTE (a parcel column the cohort already carries)
  - drawn-polygon   : { type:'drawn-polygon', geometry:<GeoJSON Polygon/MultiPolygon, EPSG:4326> } → ST_Intersects

geo.parcel_geometry.geom is EPSG:2253 (NAD83 / Michigan South, US survey FEET), so a
ST_DWithin distance in feet is used directly — no metric conversion. GeoJSON is EPSG:4326
(RFC 7946) → transformed to 2253 for the intersect.
"""
from __future__ import annotations

import json
from typing import Tuple


class CohortSelectorError(ValueError):
    """A malformed cohort selector — the route maps this to HTTP 400."""


# Whitelisted named-geography sources (DIC-588). SINGLE SOURCE of the table/column names the
# predicate builder AND the /cohort/geographies names route both read — so no identifier ever
# comes from the request (only parameterized VALUES do). `kind`:
#   spatial   — a geo.* POLYGON layer; the cohort = parcels intersecting it (by id or name).
#   attribute — a column the cohort feature query already selects; the cohort = parcels matching.
GEOGRAPHY_SOURCES = {
    "subdivision": {"kind": "spatial", "table": "geo.subdivisions", "id_col": "id", "name_col": "sub_name", "label": "subdivision"},
    "section":     {"kind": "spatial", "table": "geo.plss_sections", "id_col": "id", "name_col": "twnrngsec", "label": "section"},
    "township":    {"kind": "attribute", "column": "pg.municipality", "label": "township"},
    "school":      {"kind": "attribute", "column": "a.school_dist", "label": "school district"},
}


def build_predicate(selector: dict, limit: int) -> Tuple[str, list, dict]:
    """selector + limit → (where_predicate_sql, params, resolved_selector).

    `params` are positional (%s) in predicate order; the caller appends the LIMIT param.
    `resolved_selector` is the echo returned to the client (type + human label).
    Raises CohortSelectorError on anything malformed (fail-closed; no silent empty scan).
    """
    sel = selector or {}
    stype = (sel.get("type") or "").lower()

    if stype == "explicit":
        ids = []
        for x in (sel.get("ids") or []):
            # Tolerate numeric strings ("45154"); a non-numeric value is a PIN, not an id.
            try:
                ids.append(int(x))
            except (TypeError, ValueError):
                raise CohortSelectorError("explicit selector: ids must be integers")
        pins = [str(p).strip() for p in (sel.get("pins") or []) if str(p).strip()]
        ids = ids[:limit]
        pins = pins[:limit]
        clauses, params = [], []
        if ids:
            clauses.append("pg.id = ANY(%s)")
            params.append(ids)
        if pins:
            clauses.append("pg.parcel_no = ANY(%s)")
            params.append(pins)
        if not clauses:
            raise CohortSelectorError("explicit selector needs at least one id or pin")
        n = len(ids) + len(pins)
        pred = clauses[0] if len(clauses) == 1 else "(" + " OR ".join(clauses) + ")"
        label = "%d selected parcel%s" % (n, "" if n == 1 else "s")
        return (pred, params, {"type": "explicit", "label": label})

    if stype == "buffer":
        try:
            dist = float(sel.get("distance_ft"))
        except (TypeError, ValueError):
            raise CohortSelectorError("buffer selector needs numeric distance_ft")
        if dist <= 0:
            raise CohortSelectorError("buffer distance_ft must be > 0")
        if sel.get("parcel_id") is not None:
            pid = int(sel["parcel_id"])
            # Distance is in the geom's units (US survey feet) — direct, no conversion.
            return (
                "ST_DWithin(pg.geom, (SELECT geom FROM geo.parcel_geometry WHERE id = %s), %s)",
                [pid, dist],
                {"type": "buffer", "label": "Within %d ft of parcel %d" % (int(dist), pid)},
            )
        if sel.get("lng") is not None and sel.get("lat") is not None:
            lng, lat = float(sel["lng"]), float(sel["lat"])
            return (
                "ST_DWithin(pg.geom, ST_Transform(ST_SetSRID(ST_MakePoint(%s, %s), 4326), 2253), %s)",
                [lng, lat, dist],
                {"type": "buffer", "label": "Within %d ft of a point" % int(dist)},
            )
        raise CohortSelectorError("buffer selector needs parcel_id or lng+lat")

    if stype == "named-geography":
        geo = (sel.get("geography") or "").lower()
        src = GEOGRAPHY_SOURCES.get(geo)
        if not src:
            raise CohortSelectorError("named-geography: unknown geography %r" % geo)
        has_id = sel.get("id") is not None
        name = sel.get("name")
        has_name = name is not None and str(name).strip() != ""
        if not has_id and not has_name:
            raise CohortSelectorError("named-geography needs an id or a name")

        if src["kind"] == "spatial":
            # The cohort = parcels intersecting the named polygon. The subquery returns ONE
            # geometry (ST_Union folds a multi-row name match), and the table/column come from
            # the whitelist above — only the value is a parameter. Index-friendly like buffer's
            # ST_DWithin; a parcel straddling a boundary may appear in adjacent areas (v1).
            if has_id:
                inner = "SELECT geom FROM %s WHERE %s = %%s" % (src["table"], src["id_col"])
                param, lbl = int(sel["id"]), "%s #%s" % (src["label"], sel["id"])
            else:
                inner = "SELECT ST_Union(geom) FROM %s WHERE %s = %%s" % (src["table"], src["name_col"])
                param, lbl = str(name).strip(), str(name).strip()
            pred = "pg.geom && (%s) AND ST_Intersects(pg.geom, (%s))" % (inner, inner)
            return (pred, [param, param], {"type": "named-geography", "geography": geo, "label": lbl})

        # attribute: a parcel column the cohort feature query already carries.
        val = int(sel["id"]) if has_id else str(name).strip()
        pred = "%s = %%s" % src["column"]
        lbl = "%s %s" % (src["label"], val) if geo == "school" else str(val)
        return (pred, [val], {"type": "named-geography", "geography": geo, "label": lbl})

    if stype == "drawn-polygon":
        geom = sel.get("geometry")
        if not isinstance(geom, dict):
            raise CohortSelectorError("drawn-polygon needs a GeoJSON geometry object")
        gtype = (geom.get("type") or "")
        if gtype not in ("Polygon", "MultiPolygon"):
            raise CohortSelectorError("drawn-polygon geometry must be a Polygon or MultiPolygon")
        if not geom.get("coordinates"):
            raise CohortSelectorError("drawn-polygon geometry has no coordinates")
        # Cap the vertex count — a drawn area is a handful of points, not a dump of a coastline.
        if _count_coords(geom.get("coordinates")) > 10000:
            raise CohortSelectorError("drawn-polygon geometry is too complex")
        gj = json.dumps(geom)
        # GeoJSON is EPSG:4326 (RFC 7946) → transform to the parcel SRID (2253) for the intersect.
        pred = ("pg.geom && ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON(%s), 4326), 2253) "
                "AND ST_Intersects(pg.geom, ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON(%s), 4326), 2253))")
        return (pred, [gj, gj], {"type": "drawn-polygon", "label": "drawn area"})

    raise CohortSelectorError("unknown cohort selector type: %r" % stype)


def _count_coords(coords) -> int:
    """Total number of coordinate pairs in a nested GeoJSON coordinate array."""
    if not isinstance(coords, list):
        return 0
    if coords and isinstance(coords[0], (int, float)):
        return 1
    return sum(_count_coords(c) for c in coords)
