"""Build the e2e fixture's data from the shared parcel database and FEMA (DIC-2553).

    pip install "psycopg[binary]" shapely
    PV_DATABASE_URL=postgresql://... python e2e/fixture/build_fixture.py

Writes 20-data.sql (the parcel tables) and flood-zones.geojson (FEMA's flood zones over the
same area, for `manage.py load_flood_zones --file`, so identify and the profile are answered
from our own copy as in production, not by FEMA's slow service; DIC-2412).

Copies the real rows inside two small boxes, which is where the specs look: Paw Paw
(the z15 view at -85.905, 42.211 most specs jump to, and what a "paw paw" search finds)
and the rural spot at -86.0, 42.22 the measure tests use. Every layer the API or a Martin
tile function reads is cut to the same area, so the map, search, profiles and tiles agree.
geo.parcel_points stays empty: no viewer layer or API route reads it.

No person's details leave the database: owner names become numbered stand-ins
("FIXTURE OWNER 0001") and mailing addresses the parcel's own site address. The rest of
the roll (parcel numbers, site addresses, classes, values, legal descriptions) and the
map layers are public record and copied as they are. Staff names and free-text notes
(the ledger's operator ids, the layers' last-editor and comment columns) are emptied too. Reads only; run it again when the specs need
data outside the boxes.
"""

import json
import os
import sys
import urllib.parse
import urllib.request
from pathlib import Path

import psycopg
from shapely import box, make_valid, set_precision, unary_union
from shapely.geometry import mapping, shape

OUT = Path(__file__).with_name("20-data.sql")
FLOOD_OUT = Path(__file__).with_name("flood-zones.geojson")
# Van Buren County's FIRM, and FEMA's NFHL flood hazard zones layer (as load_flood_zones).
DFIRM = "26159C"
NFHL_LAYER = "https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28"
FLOOD_FIELDS = "FLD_AR_ID,FLD_ZONE,ZONE_SUBTY,SFHA_TF,STATIC_BFE,DEPTH,V_DATUM,DFIRM_ID,SOURCE_CIT"

# lng/lat boxes (west, south, east, north).
BOXES = {
    "paw-paw": (-85.935, 42.197, -85.875, 42.225),
    "measure": (-86.015, 42.213, -85.985, 42.227),
}

AREA = " OR ".join(
    f"{{g}} && ST_Transform(ST_MakeEnvelope({w}, {s}, {e}, {n}, 4326), 2253)"
    for w, s, e, n in BOXES.values()
)


def within(column: str) -> str:
    return "(" + AREA.format(g=column) + ")"


def layer(table: str, blank: tuple[str, ...] = ()) -> tuple[str, str]:
    """
    Takes a geo table and the columns to empty. Returns its (table, SELECT) cut to the
    boxes. Emptied columns are staff names and free-text notes, which no test reads.
    """
    if not blank:
        return table, f"SELECT * FROM {table} WHERE {within('geom')}"
    nulls = json.dumps({c: None for c in blank})
    return table, f"SELECT (jsonb_populate_record(t, '{nulls}'::jsonb)).* FROM {table} t WHERE {within('t.geom')}"


PARCELS = f"pg.archived_at IS NULL AND {within('pg.geom')}"

# (table, SELECT of its rows in column order). Order matters: the ledger refers to parcels.
TABLES = [
    ("geo.parcel_geometry", f"SELECT pg.* FROM geo.parcel_geometry pg WHERE {PARCELS}"),
    (
        "assessing.vbc_parcels",
        # Owners are replaced: a numbered stand-in name, mailed at the parcel's own address.
        "SELECT a.id, a.pnum, a.mapnum, a.school_dist, a.prop_class, a.homestead, a.qual_ag, "
        "a.frontage, a.avg_depth, a.assessed_value, a.taxable_value, a.prev_assessed_value, "
        "a.prev_taxable_value, a.assessed_value_yr0, a.assessed_value_yr1, a.assessed_value_yr2, "
        "a.assessed_value_yr3, a.assessed_value_yr4, "
        "CASE WHEN a.owner_name IS NULL THEN NULL "
        "ELSE 'FIXTURE OWNER ' || lpad((row_number() OVER (ORDER BY a.pnum, a.id))::text, 4, '0') END, "
        "a.prop_street, a.prop_city, a.prop_state, a.prop_zip, "
        "a.prop_street, a.prop_city, a.prop_state, a.prop_zip, "
        "a.legal_description, a.loaded_at "
        "FROM assessing.vbc_parcels a WHERE a.pnum IN "
        f"(SELECT pg.parcel_no FROM geo.parcel_geometry pg WHERE {PARCELS})",
    ),
    (
        "geo.parcel_ledger_events",
        # operator_id and notes are internal: replaced, never copied.
        "SELECT event_id, parcel_id, event_type, event_timestamp, 'e2e-fixture' AS operator_id, "
        "source_document, closure_error, precision_ratio, bowditch_applied, cogo_legs, "
        "geometry_before, geometry_after, related_parcel_ids, NULL AS notes "
        "FROM geo.parcel_ledger_events WHERE parcel_id IN "
        f"(SELECT pg.id FROM geo.parcel_geometry pg WHERE {PARCELS})",
    ),
    layer("geo.address_points", blank=("lasteditor", "comments", "site")),
    layer("geo.road_centerlines", blank=("notes",)),
    layer("geo.reference_layers"),
    layer("geo.drains", blank=("comments",)),
    layer("geo.subdivisions"),
    layer("geo.plss_sections"),
    layer("geo.plss_section_lines"),
    layer("geo.plss_corners"),
    layer("geo.section_centers"),
]

# Serial ids continue past the copied rows (nothing writes them in the suite, but keep it real).
SEQUENCES = [
    ("assessing.vbc_parcels", "assessing.vbc_parcels_id_seq"),
    ("geo.parcel_geometry", "geo.parcel_geometry_id_seq"),
    ("geo.address_points", "geo.address_points_id_seq"),
    ("geo.road_centerlines", "geo.road_centerlines_id_seq"),
    ("geo.reference_layers", "geo.reference_layers_id_seq"),
    ("geo.drains", "geo.drains_id_seq"),
    ("geo.subdivisions", "geo.subdivisions_id_seq"),
    ("geo.plss_sections", "geo.plss_sections_id_seq"),
    ("geo.plss_section_lines", "geo.plss_section_lines_id_seq"),
    ("geo.plss_corners", "geo.plss_corners_id_seq"),
    ("geo.section_centers", "geo.section_centers_id_seq"),
]


def flood_zones() -> int:
    """
    Fetches FEMA's zones touching the boxes and writes them clipped to the boxes, at 6 dp
    (FEMA's polygons run for miles; the clip keeps the file small). Returns the count.
    """
    features = []
    for w, s, e, n in BOXES.values():
        query = urllib.parse.urlencode({
            "where": f"DFIRM_ID='{DFIRM}'", "geometry": f"{w},{s},{e},{n}",
            "geometryType": "esriGeometryEnvelope", "inSR": 4326,
            "spatialRel": "esriSpatialRelIntersects", "outFields": FLOOD_FIELDS,
            "outSR": 4326, "returnGeometry": "true", "f": "geojson",
        })
        with urllib.request.urlopen(f"{NFHL_LAYER}/query?{query}", timeout=180) as r:  # noqa: S310
            page = json.loads(r.read().decode())
        for f in page.get("features") or []:
            clipped = set_precision(make_valid(shape(f["geometry"])).intersection(box(w, s, e, n)), 1e-6)
            if clipped.geom_type == "GeometryCollection":
                clipped = unary_union([g for g in clipped.geoms if g.geom_type.endswith("Polygon")])
            if clipped.is_empty or not clipped.geom_type.endswith("Polygon"):
                continue
            features.append({"type": "Feature", "properties": f["properties"], "geometry": mapping(clipped)})
    FLOOD_OUT.write_text(
        json.dumps({"type": "FeatureCollection", "features": features}, separators=(",", ":")),
        encoding="utf-8",
    )
    return len(features)


def main() -> int:
    url = os.environ.get("PV_DATABASE_URL")
    if not url:
        print("Set PV_DATABASE_URL to the shared parcel database (read-only is enough).")
        return 2
    counts = {}
    with psycopg.connect(url, options="-c default_transaction_read_only=on") as conn:
        with OUT.open("w", encoding="utf-8", newline="\n") as out:
            out.write(
                "-- e2e fixture database, part 2: the data (DIC-2553). Generated by\n"
                "-- build_fixture.py from the shared parcel database; don't edit by hand.\n"
                f"-- Boxes (lng/lat): {BOXES}\n\n"
                "SET client_encoding = 'UTF8';\n"
                # The trigger would stamp updated_at with the load time; keep the real rows.
                "ALTER TABLE geo.parcel_geometry DISABLE TRIGGER parcel_geometry_before_write_trg;\n\n"
            )
            for table, select in TABLES:
                out.write(f"COPY {table} FROM stdin;\n")
                n = 0
                with conn.cursor().copy(f"COPY ({select} ORDER BY 1) TO STDOUT") as copy:
                    for chunk in copy:
                        text = bytes(chunk).decode("utf-8")
                        n += text.count("\n")
                        out.write(text)
                out.write("\\.\n\n")
                counts[table] = n
            out.write("ALTER TABLE geo.parcel_geometry ENABLE TRIGGER parcel_geometry_before_write_trg;\n\n")
            for table, seq in SEQUENCES:
                out.write(
                    f"SELECT setval('{seq}', COALESCE((SELECT max(id) FROM {table}), 0) + 1, false);\n"
                )
            out.write("\nANALYZE;\n")
    counts["flood zones (FEMA)"] = flood_zones()
    for table, n in counts.items():
        print(f"{table:28} {n:6}")
    print(f"wrote {OUT} ({OUT.stat().st_size / 1e6:.1f} MB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
