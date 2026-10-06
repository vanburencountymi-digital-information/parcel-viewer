"""Parcel reads (ADR 0006): the FastAPI backend's tuned SQL, behind one repository.

The SQL is carried over verbatim from backend/parcel_viewer (routers/parcels.py and
stores/parcel_store.py) so responses stay identical (ADR 0011). Geometry is stored in
EPSG:2253 and leaves as GeoJSON in EPSG:4326.
"""

from typing import Any

from common.db import fetch_all, fetch_one
from common.enums import DatabaseAlias

PARCELS = DatabaseAlias.PARCELS

# Each word adds a clause to the search; 8 is plenty for a name, address or PIN (DIC-1872).
MAX_SEARCH_TOKENS = 8

FEATURE_PROPS_SQL = """
    pg.id                AS id,
    pg.parcel_no         AS pin,
    pg.parcel_no         AS parcel_no,
    pg.municipality      AS municipality,
    -- True area from geometry (geodesic), NOT the stored pg.acres column, which
    -- is unreliable (most rows default to 1.0 or 0.0). Same formula as the
    -- /parcel/{id} computed_acres so label and popup acreage agree. (DIC-521)
    ST_Area(ST_Transform(pg.geom, 4326)::geography) / 4046.8564224 AS gis_acres,
    pg.source            AS source,
    a.owner_name         AS owner_name,
    a.prop_street        AS "PCOMBINED",
    a.prop_class         AS prop_class,
    a.school_dist        AS school_dist,
    a.assessed_value     AS assessed_value,
    a.taxable_value      AS taxable_value
"""

# Cohort feature props (DIC-587): the parcel attributes the cohort-analyze core aggregates
# over. The bbox feature props plus the prior-period values behind the value-change
# aggregator. No geometry: aggregation is non-spatial, so the payload stays light.
COHORT_PROPS_SQL = (
    FEATURE_PROPS_SQL
    + """,
    a.prev_assessed_value AS prev_assessed_value,
    a.prev_taxable_value  AS prev_taxable_value
"""
)

PARCEL_SQL = """
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
           a.legal_description, a.loaded_at AS assessing_loaded_at,
           ST_AsGeoJSON(ST_Transform(pg.geom, 4326), 7) AS geojson
    FROM geo.parcel_geometry pg
    LEFT JOIN assessing.vbc_parcels a ON a.pnum = pg.parcel_no
    WHERE pg.id = %s AND pg.archived_at IS NULL
"""

BBOX_SQL = f"""
    SELECT {FEATURE_PROPS_SQL},
           -- 6 dp ~0.11 m: ample for parcel display/snapping, ~a tenth
           -- smaller payload than 7 dp (DIC-528).
           ST_AsGeoJSON(ST_Transform(pg.geom, 4326), 6) AS geojson
    FROM geo.parcel_geometry pg
    LEFT JOIN assessing.vbc_parcels a ON a.pnum = pg.parcel_no
    WHERE pg.archived_at IS NULL
      AND pg.geom && ST_Transform(ST_MakeEnvelope(%s, %s, %s, %s, 4326), 2253)
    LIMIT %s
"""

HISTORY_SQL = """
    SELECT event_id, parcel_id, event_type, event_timestamp,
           source_document, closure_error, precision_ratio, bowditch_applied,
           related_parcel_ids
    FROM geo.parcel_ledger_events
    WHERE parcel_id = %s OR %s = ANY(COALESCE(related_parcel_ids, '{}'))
    ORDER BY event_timestamp DESC
    LIMIT %s
"""

NEAREST_ROAD_SQL = """
    SELECT ST_X(g) AS lng, ST_Y(g) AS lat
    FROM (
        SELECT ST_Transform(ST_ClosestPoint(geom, p), 4326) AS g
        FROM geo.reference_layers,
             (SELECT ST_Transform(ST_SetSRID(ST_MakePoint(%s, %s), 4326), 2253) AS p) pt
        WHERE feature_type = 'road'
        ORDER BY geom <-> p
        LIMIT 1
    ) q
"""

STREETVIEW_SQL = """
    WITH p AS (
        SELECT geom FROM geo.parcel_geometry WHERE id = %s AND archived_at IS NULL
    ),
    ap AS (
        -- The county's address-point layer calls the full address `fulladdr`
        -- (reloaded from its shapefile; it was `full_address` before, DIC-2152).
        SELECT a.geom, a.fulladdr AS full_address
        FROM geo.address_points a, p
        WHERE ST_Contains(p.geom, a.geom)
        LIMIT 1
    ),
    anchor AS (
        SELECT COALESCE((SELECT geom FROM ap), (SELECT ST_PointOnSurface(geom) FROM p)) AS g
    ),
    road AS (
        SELECT ST_ClosestPoint(r.geom, (SELECT g FROM anchor)) AS g
        FROM geo.reference_layers r
        WHERE r.feature_type = 'road'
        ORDER BY r.geom <-> (SELECT g FROM anchor)
        LIMIT 1
    )
    SELECT
        ST_X(ST_Transform((SELECT g FROM anchor), 4326)) AS anchor_lng,
        ST_Y(ST_Transform((SELECT g FROM anchor), 4326)) AS anchor_lat,
        ST_X(ST_Transform((SELECT g FROM road), 4326))   AS road_lng,
        ST_Y(ST_Transform((SELECT g FROM road), 4326))   AS road_lat,
        (SELECT full_address FROM ap)                    AS address,
        ((SELECT geom FROM ap) IS NOT NULL)              AS has_address
"""


def search_sql(tokens: list[str]) -> tuple[str, list[Any]]:
    """
    Takes the search words (already capped at MAX_SEARCH_TOKENS). Returns the search SQL
    and its parameters, without the trailing LIMIT value.

    Every word must match the PIN, owner, street or city (good recall). Rows are then
    ranked so the address that starts with the typed phrase wins, and a numeric first word
    only counts as a whole house number: "219 E Paw Paw" mustn't rank "34219 ..." first.
    """
    clauses = []
    params: list[Any] = []
    for token in tokens:
        clauses.append(
            "(pg.parcel_no ILIKE %s OR a.owner_name ILIKE %s OR a.prop_street ILIKE %s OR a.prop_city ILIKE %s)"
        )
        like = f"%{token}%"
        params.extend([like, like, like, like])

    phrase = " ".join(tokens)
    rank_when = [
        ("a.prop_street ILIKE %s", phrase + "%"),
        (
            "(COALESCE(a.prop_street, '') || ' ' || COALESCE(a.prop_city, '')) ILIKE %s",
            phrase + "%",
        ),
        ("a.prop_street ILIKE %s", "%" + phrase + "%"),
    ]
    if tokens[0].isdigit():
        # Word boundary on the house number: matches "219 ..." but not "34219 ...".
        rank_when.append(("a.prop_street ~* %s", r"(^|\D)" + tokens[0] + r"(\D|$)"))
    rank_case = (
        "CASE "
        + " ".join(f"WHEN {cond} THEN {i}" for i, (cond, _) in enumerate(rank_when))
        + f" ELSE {len(rank_when)} END"
    )
    params.extend(value for _, value in rank_when)

    sql = f"""
        SELECT pg.id, pg.parcel_no, pg.municipality, pg.acres,
               a.owner_name, a.prop_street, a.prop_city,
               ST_XMin(bb.b) AS w, ST_YMin(bb.b) AS s,
               ST_XMax(bb.b) AS e, ST_YMax(bb.b) AS n
        FROM geo.parcel_geometry pg
        LEFT JOIN assessing.vbc_parcels a ON a.pnum = pg.parcel_no
        CROSS JOIN LATERAL (SELECT ST_Transform(pg.geom, 4326)::box2d::geometry AS b) bb
        WHERE pg.archived_at IS NULL AND {" AND ".join(clauses)}
        ORDER BY {rank_case}, pg.parcel_no
        LIMIT %s
    """
    return sql, params


class ParcelRepository:
    """Every read of parcel data. Rows are dicts with the database's column names."""

    def get_parcel(self, parcel_id: int) -> dict[str, Any] | None:
        """Takes a parcel id. Returns its full joined row (with geojson), or None if absent or archived."""
        return fetch_one(PARCELS, PARCEL_SQL, [parcel_id])

    def in_bbox(
        self, west: float, south: float, east: float, north: float, limit: int
    ) -> list[dict[str, Any]]:
        """Takes a lng/lat bounding box and a row cap. Returns feature rows (with geojson), unordered."""
        return fetch_all(PARCELS, BBOX_SQL, [west, south, east, north, limit])

    def search(self, tokens: list[str], limit: int) -> list[dict[str, Any]]:
        """Takes search words and a row cap. Returns matching rows, best match first."""
        sql, params = search_sql(tokens)
        return fetch_all(PARCELS, sql, [*params, limit])

    def history(self, parcel_id: int, limit: int) -> list[dict[str, Any]]:
        """Takes a parcel id and a row cap. Returns its ledger events and those naming it, newest first."""
        return fetch_all(PARCELS, HISTORY_SQL, [parcel_id, parcel_id, limit])

    def nearest_road_point(self, lng: float, lat: float) -> dict[str, Any] | None:
        """Takes a lng/lat point. Returns the closest point on the nearest road, or None."""
        return fetch_one(PARCELS, NEAREST_ROAD_SQL, [lng, lat])

    def streetview_target(self, parcel_id: int) -> dict[str, Any] | None:
        """Takes a parcel id. Returns its Street View anchor, road point and address point."""
        return fetch_one(PARCELS, STREETVIEW_SQL, [parcel_id])

    def cohort(self, predicate: str, params: list[Any], limit: int) -> list[dict[str, Any]]:
        """
        Takes a cohort predicate from cohort_query.build_predicate, its parameters and a cap.
        Returns the cohort's feature rows (no geometry), unordered.
        """
        sql = f"""
            SELECT {COHORT_PROPS_SQL}
            FROM geo.parcel_geometry pg
            LEFT JOIN assessing.vbc_parcels a ON a.pnum = pg.parcel_no
            WHERE pg.archived_at IS NULL AND {predicate}
            LIMIT %s
        """
        return fetch_all(PARCELS, sql, [*params, limit])

    def cohort_center(self, predicate: str, params: list[Any]) -> dict[str, Any] | None:
        """
        Takes a cohort predicate and its parameters. Returns the lng/lat centroid of the
        matched set's bounding box: a cheap anchor the viewer samples for a center-point
        environmental read while flood, wetland and soil layers are WMS-only.
        """
        sql = f"""
            SELECT ST_X(c) AS lng, ST_Y(c) AS lat FROM (
                SELECT ST_Transform(ST_SetSRID(ST_Centroid(ST_Extent(pg.geom)::geometry), 2253), 4326) AS c
                FROM geo.parcel_geometry pg
                LEFT JOIN assessing.vbc_parcels a ON a.pnum = pg.parcel_no
                WHERE pg.archived_at IS NULL AND {predicate}
            ) q
        """
        return fetch_one(PARCELS, sql, params)

    def parcel_number(self, parcel_id: int) -> str | None:
        """Takes a parcel id. Returns its parcel number (PIN), or None."""
        row = fetch_one(
            PARCELS, "SELECT parcel_no FROM geo.parcel_geometry WHERE id = %s", [parcel_id]
        )
        return row.get("parcel_no") if row else None

    def geographies(self, source: dict[str, Any]) -> list[dict[str, Any]]:
        """
        Takes a whitelisted source from cohort_query.GEOGRAPHY_SOURCES (never request text).
        Returns [{id, name}] by name: polygon layers by their own ids, attribute geographies
        (township, school district) as the distinct values of a parcel column, with id None.
        """
        if source["kind"] == "spatial":
            sql = (
                "SELECT {} AS id, {} AS name FROM {} WHERE {} IS NOT NULL AND {} <> '' ORDER BY name"
            ).format(
                source["id_col"],
                source["name_col"],
                source["table"],
                source["name_col"],
                source["name_col"],
            )
            return [{"id": r["id"], "name": r["name"]} for r in fetch_all(PARCELS, sql)]
        column = source["column"]
        join = (
            "LEFT JOIN assessing.vbc_parcels a ON a.pnum = pg.parcel_no"
            if column.startswith("a.")
            else ""
        )
        sql = (
            f"SELECT DISTINCT {column} AS name FROM geo.parcel_geometry pg {join} "
            f"WHERE pg.archived_at IS NULL AND {column} IS NOT NULL AND {column} <> '' ORDER BY name"
        )
        return [{"id": None, "name": r["name"]} for r in fetch_all(PARCELS, sql)]
