"""PostGIS layer discovery for the Admin Console (DIC-502), ported from backend/app/main.py.

Introspects the spatial layers Martin can serve (geo.<name>_tiles functions) so staff can
register them as viewer overlays without a developer. Read-only, through the parcels
connection; it runs count(*) on geo tables, so the route is admin-only and cached.
"""

import logging
import re
from typing import Any

from common.db import fetch_all, fetch_one
from common.enums import DatabaseAlias
from county_config.store import published_config

log = logging.getLogger(__name__)

PARCELS = DatabaseAlias.PARCELS

# PostGIS GeometryType() → the viewer's geomType.
GEOM_KIND = {
    "POINT": "point",
    "MULTIPOINT": "point",
    "LINESTRING": "line",
    "MULTILINESTRING": "line",
    "POLYGON": "polygon",
    "MULTIPOLYGON": "polygon",
}
# reference_layers is one table split into several tile functions by feature_type.
REFERENCE_FEATURE = {"roads": "road", "drains": "drain", "section_lines": "section_line"}
# parcels is the base layer, not an overlay.
BASE_LAYER = "parcel"
_COLUMN = re.compile(r"\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*$")


def tile_fields(source: str) -> list[str]:
    """
    Takes a tile function's definition. Returns the non-geometry properties it exposes, parsed
    from the SELECT list feeding ST_AsMVT (before ST_AsMVTGeom), for the console's pickers.
    """
    if not source:
        return []
    i = source.find("ST_AsMVTGeom")
    if i < 0:
        return []
    head = source[:i]
    j = head.rfind("SELECT")
    if j < 0:
        return []
    out: list[str] = []
    for part in head[j + 6 :].split(","):
        match = _COLUMN.match(part)
        if match:
            name = match.group(1).lower()
            if name not in ("geom", "id"):
                out.append(name)
    return out


def _sample(table: str, feature_type: str | None) -> tuple[str | None, int | None, int | None]:
    """
    Takes a geo table (names come from the database catalogue, never the request) and an
    optional feature_type filter. Returns (geometry kind, SRID, row count); Nones if it can't tell.
    """
    ident = f'geo."{table}"'
    clause = " WHERE feature_type = %s" if feature_type else ""
    args = [feature_type] if feature_type else []
    kind = srid = count = None
    try:
        sample = fetch_one(
            PARCELS,
            f"SELECT GeometryType(geom) AS gt, ST_SRID(geom) AS srid FROM {ident}"
            + (clause or " WHERE geom IS NOT NULL")
            + " LIMIT 1",
            args,
        )
        if sample:
            kind = GEOM_KIND.get((sample["gt"] or "").upper())
            srid = sample["srid"]
        row = fetch_one(PARCELS, f"SELECT count(*) AS n FROM {ident}{clause}", args)
        count = row["n"] if row else 0
    except Exception:  # noqa: BLE001 — discovery never fails the request over one table
        log.debug("layer discovery: couldn't sample %s", table, exc_info=True)
    return kind, srid, count


def discover_layers(county: str) -> list[dict[str, Any]]:
    """Takes a county. Returns the Martin tile layers, each marked registered if its config already has it."""
    config = published_config(county) or {}
    overlays = (config.get("layers") or {}).get("overlays") or []
    registered = {o.get("source") for o in overlays if str(o.get("type", "")).lower() == "vector"}

    functions = fetch_all(
        PARCELS,
        "SELECT proname, pg_get_functiondef(p.oid) AS def "
        "FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace "
        "WHERE n.nspname = 'geo' AND proname LIKE %s ORDER BY proname",
        ["%\\_tiles"],
    )
    tables = {
        r["relname"]
        for r in fetch_all(
            PARCELS,
            "SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace "
            "WHERE n.nspname = 'geo' AND c.relkind IN ('r', 'v', 'm', 'p')",
        )
    }

    layers: list[dict[str, Any]] = []
    for function in functions:
        source = function["proname"]  # e.g. "subdivisions_tiles"
        base = source[:-6] if source.endswith("_tiles") else source
        if base == BASE_LAYER:
            continue
        db_table: str | None
        if base in tables:
            kind, srid, count = _sample(base, None)
            db_table = f"geo.{base}"
        elif base.startswith("reference_"):
            feature_type = REFERENCE_FEATURE.get(base[len("reference_") :])
            kind, srid, count = (
                _sample("reference_layers", feature_type) if feature_type else (None, None, None)
            )
            db_table = "geo.reference_layers" + (
                f" (feature_type={feature_type})" if feature_type else ""
            )
        else:
            kind, srid, count, db_table = None, None, None, None
        layers.append(
            {
                "id": base,
                "source": source,
                "sourceLayer": base,
                "geomType": kind,
                "srid": srid,
                "rowCount": count,
                "dbSource": db_table,
                "registered": source in registered,
                "fields": tile_fields(function["def"]),
            }
        )
    return layers
