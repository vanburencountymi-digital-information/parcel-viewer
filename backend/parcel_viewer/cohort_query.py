"""cohort_query.py — pure cohort-selector → SQL predicate builder (DIC-587).

The /cohort route resolves a cohort SELECTOR to a feature SET; the deterministic
AGGREGATION then runs in the engine core (engine/capabilities/cohort-analyze.core.js) —
single source of truth, no SQL/JS drift. This module is the spatial-selection half:
selector dict → (WHERE predicate, params, resolved-selector). It has NO DB imports, so the
harness unit-tests the selector logic + validation with no database.

Selectors (v1):
  - explicit : { type:'explicit', ids:[int, ...] }                         → pg.id = ANY()
  - buffer   : { type:'buffer', parcel_id:int, distance_ft:float }         → ST_DWithin (around a parcel)
               { type:'buffer', lng:float, lat:float, distance_ft:float }  → ST_DWithin (around a point)

geo.parcel_geometry.geom is EPSG:2253 (NAD83 / Michigan South, US survey FEET), so a
ST_DWithin distance in feet is used directly — no metric conversion.
"""
from __future__ import annotations

from typing import Tuple


class CohortSelectorError(ValueError):
    """A malformed cohort selector — the route maps this to HTTP 400."""


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
            try:
                ids.append(int(x))
            except (TypeError, ValueError):
                raise CohortSelectorError("explicit selector: ids must be integers")
        ids = ids[:limit]
        if not ids:
            raise CohortSelectorError("explicit selector needs at least one id")
        label = "%d selected parcel%s" % (len(ids), "" if len(ids) == 1 else "s")
        return ("pg.id = ANY(%s)", [ids], {"type": "explicit", "label": label})

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

    raise CohortSelectorError("unknown cohort selector type: %r" % stype)
