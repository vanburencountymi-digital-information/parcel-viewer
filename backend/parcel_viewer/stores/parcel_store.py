"""parcel_store.py — ParcelStore, PV/DICE-VBC implementation (A6 / DIC-570).

PV's home of the parcel data abstraction. Decouples the `/parcel/{id}` route from the
hardcoded `geo.parcel_geometry` ⋈ `assessing.vbc_parcels` schema (EPSG:2253, MI survey
conventions) so the route no longer owns inline SQL.

`get_parcel(id)` returns BOTH:
  - `raw`       : the full selected row (dict) — the route builds its exact GeoJSON
                  Feature from this, so the response is byte-for-byte unchanged.
  - `canonical` : the cross-backend normalized parcel record — the SAME shape the ZIP
                  backend's ParcelStore produces (facts-parity, §4.6). This is the shared
                  CONTRACT; the implementations differ by driver (PV = psycopg3/dict rows,
                  ZIP = psycopg2/tuple rows), so each consumer keeps its own impl. The
                  remaining D1 step is to extract this canonical-record contract into a
                  package both repos import (a cross-repo packaging decision).

The row fetch is INJECTED (`fetch_one(sql, params) -> dict | None`), so the harness
exercises the SQL + canonical mapping with no live DB. `make_parcel_store()` wires the
default to the psycopg3 pool.
"""
from __future__ import annotations

from typing import Callable, Optional

try:
    from .parcel_contract import ParcelStore, canonical_parcel
except ImportError:   # standalone load (harness): the stores dir is on sys.path
    from parcel_contract import ParcelStore, canonical_parcel

# The full /parcel/{id} projection. Kept verbatim from the route so `raw` reproduces the
# exact Feature the viewer expects (geometry + every property it renders).
_PARCEL_SQL = """
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


def _to_canonical(r: dict) -> dict:
    """Map a VBC joined row (dict) to the cross-backend canonical parcel record. The shape
    is owned by parcel_contract.canonical_parcel (shared with the ZIP backend)."""
    return canonical_parcel(
        id=r.get("id"),
        pin=r.get("parcel_no"),
        county=r.get("county"),
        municipality=r.get("municipality"),
        gis_acres=r.get("computed_acres") if r.get("computed_acres") else r.get("acres"),
        owner={"name": r.get("owner_name"), "address": r.get("owner_street"),
               "city": r.get("owner_city"), "state": r.get("owner_state"), "zip": r.get("owner_zip")},
        site={"address": r.get("prop_street"), "city": r.get("prop_city"),
              "state": r.get("prop_state"), "zip": r.get("prop_zip")},
        school=r.get("school_dist"),
        prop_class=r.get("prop_class"),
        zoning=None,                                      # VBC parcels carry no parcel zoning
        pre={"current": r.get("homestead")},
        legal_description=r.get("ps_legal_description") or r.get("legal_description"),
        assessment_current={"assessed": r.get("assessed_value"), "taxable": r.get("taxable_value")},
        assessment_detail={
            "previous": {"assessed": r.get("prev_assessed_value"), "taxable": r.get("prev_taxable_value")},
            "rolling": [r.get(f"assessed_value_yr{i}") for i in range(5)],
        },
        source_backend="dice-vbc",
    )


class DiceVbcParcelStore(ParcelStore):
    """`geo.parcel_geometry` ⋈ `assessing.vbc_parcels`, keyed by integer id."""

    SQL = _PARCEL_SQL

    def __init__(self, fetch_one: Callable[[str, tuple], Optional[dict]]):
        self._fetch_one = fetch_one

    def get_parcel(self, parcel_id) -> Optional[dict]:
        row = self._fetch_one(self.SQL, (parcel_id,))
        if not row:
            return None
        return {"raw": row, "canonical": _to_canonical(row)}


def _pool_fetch_one(sql: str, params: tuple) -> Optional[dict]:
    from ..db import pool   # lazy so the module imports without a live DB (harness)

    with pool.connection() as conn:
        return conn.execute(sql, params).fetchone()


def make_parcel_store(fetch_one: Optional[Callable] = None) -> DiceVbcParcelStore:
    """Default store, wired to the psycopg3 pool. Pass `fetch_one` to inject (tests)."""
    return DiceVbcParcelStore(fetch_one or _pool_fetch_one)
