"""Read endpoints: property card, omni-search, bbox parcel hydration, history.

All geometry leaves the API as GeoJSON in EPSG:4326; storage is EPSG:2253
(NAD83 / Michigan South, US ft) per county-data-services schema.
"""

import json

from fastapi import APIRouter, HTTPException, Query

from .. import config
from ..db import pool

router = APIRouter()

_FEATURE_PROPS_SQL = """
    pg.id                AS id,
    pg.parcel_no         AS pin,
    pg.parcel_no         AS parcel_no,
    pg.municipality      AS municipality,
    pg.acres             AS gis_acres,
    pg.source            AS source,
    a.owner_name         AS owner_name,
    a.prop_street        AS "PCOMBINED",
    a.prop_class         AS prop_class,
    a.assessed_value     AS assessed_value,
    a.taxable_value      AS taxable_value
"""


@router.get("/style.json")
async def style_json():
    """MapLibre style for the parcel map."""
    return {
        "version": 8,
        "name": "Parcel Viewer Base Style",
        "center": config.MAP_CENTER,
        "zoom": 11,
        "glyphs": "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf",
        "sources": {
            "mi-aerial": {
                "type": "raster",
                "tiles": [
                    "https://imagery.michigan.gov/server/rest/services/Michigan_imagery_2024/ImageServer/exportImage?bbox={bbox-epsg-3857}&bboxSR=3857&size=256,256&imageSR=3857&format=jpg&pixelType=U8&noDataInterpretation=esriNoDataMatchAny&interpolation=+RSP_NearestNeighbor&f=image"
                ],
                "tileSize": 256,
                "attribution": "Michigan DTMB / USDA NAIP 2024",
            },
            "carto-positron": {
                "type": "raster",
                "tiles": [
                    "https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png",
                    "https://b.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png",
                    "https://c.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png",
                    "https://d.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png",
                ],
                "tileSize": 256,
                "attribution": "(c) OpenStreetMap contributors (c) CARTO",
            },
            "parcels": {
                "type": "vector",
                "tiles": ["{MARTIN_URL}/parcel_tiles/{z}/{x}/{y}"],
                "minzoom": 0,
                "maxzoom": 22,
                "promoteId": {"parcels": "pin"},
            },
        },
        "layers": [
            {"id": "basemap", "type": "raster", "source": "carto-positron", "minzoom": 0, "maxzoom": 19},
            {
                "id": "mi-aerial", "type": "raster", "source": "mi-aerial",
                "minzoom": 0, "maxzoom": 19, "layout": {"visibility": "none"},
            },
            {
                "id": "parcels-fill", "type": "fill", "source": "parcels", "source-layer": "parcels",
                "paint": {
                    "fill-color": "#FDF6E3",
                    "fill-opacity": ["interpolate", ["linear"], ["zoom"], 11, 0.45, 14, 0.5, 17, 0.55],
                },
            },
            {
                "id": "parcels-line", "type": "line", "source": "parcels", "source-layer": "parcels",
                "paint": {
                    "line-color": "#8a7a55",
                    "line-opacity": 0.85,
                    "line-width": ["interpolate", ["linear"], ["zoom"], 11, 0.3, 14, 0.6, 17, 1.2, 19, 2],
                },
            },
            {
                "id": "parcels-hover", "type": "line", "source": "parcels", "source-layer": "parcels",
                "paint": {"line-color": "#111827", "line-width": 2, "line-opacity": 0.9},
                "filter": ["==", ["get", "pin"], ""],
            },
            {
                "id": "parcels-selected-fill", "type": "fill", "source": "parcels", "source-layer": "parcels",
                "paint": {"fill-color": "#ffffff", "fill-opacity": 0.18},
                "filter": ["==", ["get", "pin"], ""],
            },
            {
                "id": "parcels-selected-line", "type": "line", "source": "parcels", "source-layer": "parcels",
                "paint": {"line-color": "#0b1220", "line-width": 3, "line-opacity": 1},
                "filter": ["==", ["get", "pin"], ""],
            },
            {
                # Legacy auto-PIN label. Hidden by default (DIC-504): parcel
                # labeling is owned by the "Parcel Labels" tool (parcel-labels.js),
                # which is richer (field picker, sizing). This layer is kept only
                # as a stable insertion anchor (`before: "parcels-labels"` in map.js).
                "id": "parcels-labels", "type": "symbol", "source": "parcels", "source-layer": "parcels",
                "minzoom": 15,
                "layout": {
                    "visibility": "none",
                    "text-field": ["get", "pin"],
                    "text-font": ["Noto Sans Regular"],
                    "text-size": ["interpolate", ["linear"], ["zoom"], 15, 9, 17, 12, 19, 14],
                    "text-allow-overlap": False,
                    "text-padding": 2,
                    "symbol-placement": "point",
                },
                "paint": {
                    "text-color": "#1f2937",
                    "text-halo-color": "#ffffff",
                    "text-halo-width": 1.4,
                    "text-halo-blur": 0.4,
                },
            },
        ],
    }


def _row_to_feature(row: dict) -> dict:
    geometry = json.loads(row.pop("geojson")) if row.get("geojson") else None
    return {"type": "Feature", "id": row.get("id"), "geometry": geometry, "properties": row}


@router.get("/parcels")
async def parcels_bbox(
    bbox: str = Query(..., description="west,south,east,north in EPSG:4326"),
    limit: int = Query(4000, le=10000),
):
    try:
        w, s, e, n = (float(v) for v in bbox.split(","))
    except ValueError:
        raise HTTPException(status_code=400, detail="bbox must be west,south,east,north")

    sql = f"""
        SELECT {_FEATURE_PROPS_SQL},
               ST_AsGeoJSON(ST_Transform(pg.geom, 4326), 7) AS geojson
        FROM geo.parcel_geometry pg
        LEFT JOIN assessing.vbc_parcels a ON a.pnum = pg.parcel_no
        WHERE pg.archived_at IS NULL
          AND pg.geom && ST_Transform(ST_MakeEnvelope(%s, %s, %s, %s, 4326), 2253)
        LIMIT %s
    """
    with pool.connection() as conn:
        rows = conn.execute(sql, (w, s, e, n, limit)).fetchall()

    return {"type": "FeatureCollection", "features": [_row_to_feature(r) for r in rows]}


@router.get("/search")
async def search(q: str = Query(..., min_length=2), limit: int = Query(10, le=50)):
    tokens = [t for t in q.strip().split() if t]
    if not tokens:
        return {"results": []}

    clauses = []
    params: list = []
    for t in tokens:
        clauses.append(
            "(pg.parcel_no ILIKE %s OR a.owner_name ILIKE %s OR a.prop_street ILIKE %s OR a.prop_city ILIKE %s)"
        )
        like = f"%{t}%"
        params.extend([like, like, like, like])

    # Relevance ranking. The WHERE above matches each token as a substring
    # anywhere (good recall), but on its own that loses word order and the
    # house-number boundary — so "219 E Paw Paw" ranks behind "34219 ..." because
    # the "219" substring hides inside "34219". Score rows so the address that
    # actually starts with the typed phrase wins, and a numeric first token only
    # counts when it stands alone (not buried in a longer number).
    qnorm = " ".join(tokens)
    rank_when = [
        ("a.prop_street ILIKE %s", qnorm + "%"),
        ("(COALESCE(a.prop_street, '') || ' ' || COALESCE(a.prop_city, '')) ILIKE %s", qnorm + "%"),
        ("a.prop_street ILIKE %s", "%" + qnorm + "%"),
    ]
    if tokens[0].isdigit():
        # Word boundary on the house number: matches "219 ..." but not "34219 ...".
        rank_when.append(("a.prop_street ~* %s", r"(^|\D)" + tokens[0] + r"(\D|$)"))
    rank_case = (
        "CASE "
        + " ".join(f"WHEN {cond} THEN {i}" for i, (cond, _) in enumerate(rank_when))
        + f" ELSE {len(rank_when)} END"
    )
    rank_params = [p for _, p in rank_when]

    sql = f"""
        SELECT pg.id, pg.parcel_no, pg.municipality, pg.acres,
               a.owner_name, a.prop_street, a.prop_city,
               ST_XMin(bb.b) AS w, ST_YMin(bb.b) AS s,
               ST_XMax(bb.b) AS e, ST_YMax(bb.b) AS n
        FROM geo.parcel_geometry pg
        LEFT JOIN assessing.vbc_parcels a ON a.pnum = pg.parcel_no
        CROSS JOIN LATERAL (SELECT ST_Transform(pg.geom, 4326)::box2d::geometry AS b) bb
        WHERE pg.archived_at IS NULL AND {' AND '.join(clauses)}
        ORDER BY {rank_case}, pg.parcel_no
        LIMIT %s
    """
    params.extend(rank_params)
    params.append(limit)
    with pool.connection() as conn:
        rows = conn.execute(sql, params).fetchall()

    return {
        "results": [
            {
                "id": r["id"],
                "pin": r["parcel_no"],
                "owner_name": r["owner_name"],
                "address": ", ".join(filter(None, [r["prop_street"], r["prop_city"]])),
                "municipality": r["municipality"],
                "acres": r["acres"],
                "bbox": [r["w"], r["s"], r["e"], r["n"]],
            }
            for r in rows
        ]
    }


@router.get("/parcel/{parcel_id}")
async def get_parcel(parcel_id: int):
    sql = """
        SELECT pg.id, pg.parcel_no, pg.county, pg.municipality, pg.acres, pg.area,
               ST_Area(ST_Transform(pg.geom, 4326)::geography) / 4046.8564224 AS computed_acres,
               pg.source, pg.source_file, pg.cogo_legs, pg.legal_description AS ps_legal_description,
               pg.tax_description, pg.created_at, pg.updated_at,
               a.owner_name, a.prop_street, a.prop_city, a.prop_state, a.prop_zip,
               a.owner_street, a.owner_city, a.owner_state, a.owner_zip,
               a.school_dist, a.prop_class, a.homestead, a.qual_ag,
               a.frontage, a.avg_depth,
               a.assessed_value, a.taxable_value, a.prev_assessed_value, a.prev_taxable_value,
               a.assessed_value_yr0, a.assessed_value_yr1, a.assessed_value_yr2,
               a.assessed_value_yr3, a.assessed_value_yr4,
               a.legal_description,
               ST_AsGeoJSON(ST_Transform(pg.geom, 4326), 7) AS geojson
        FROM geo.parcel_geometry pg
        LEFT JOIN assessing.vbc_parcels a ON a.pnum = pg.parcel_no
        WHERE pg.id = %s
    """
    with pool.connection() as conn:
        row = conn.execute(sql, (parcel_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Parcel not found")

    row["pin"] = row["parcel_no"]
    row["gis_acres"] = row["computed_acres"] if row.get("computed_acres") else row["acres"]
    row["PCOMBINED"] = row["prop_street"]
    for key in ("created_at", "updated_at"):
        if row.get(key) is not None:
            row[key] = row[key].isoformat()
    return _row_to_feature(row)


@router.get("/parcel/{parcel_id}/history")
async def parcel_history(parcel_id: int, limit: int = Query(50, le=200)):
    sql = """
        SELECT event_id, parcel_id, event_type, event_timestamp, operator_id,
               source_document, closure_error, precision_ratio, bowditch_applied,
               related_parcel_ids, notes
        FROM geo.parcel_ledger_events
        WHERE parcel_id = %s OR %s = ANY(COALESCE(related_parcel_ids, '{}'))
        ORDER BY event_timestamp DESC
        LIMIT %s
    """
    with pool.connection() as conn:
        rows = conn.execute(sql, (parcel_id, parcel_id, limit)).fetchall()
    for r in rows:
        r["event_id"] = str(r["event_id"])
        r["event_timestamp"] = r["event_timestamp"].isoformat()
        if r.get("closure_error") is not None:
            r["closure_error"] = float(r["closure_error"])
    return {"events": rows}
