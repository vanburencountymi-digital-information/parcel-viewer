"""parcel_contract.py — the shared ParcelStore CONTRACT (A6 / DIC-570, D1).

CANONICAL SOURCE. The Parcel Viewer backend (psycopg3) and the ZIP backend (psycopg2)
each have their OWN ParcelStore implementation — different drivers, different row types,
different SQL — but both must return the SAME canonical parcel record. That shared shape
is the contract, and it lives here ONCE so the two impls can't drift.

Mirrors the A8 drawing-stack pattern (engine/drawing/): a single master + a generator
that writes verbatim copies into each backend + a CI drift-guard. Python is identical in
both repos (no namespace prefix), so the copies are byte-for-byte — see
engine/stores/generate.mjs and engine/test/parcel-contract-sync.test.js. After editing
THIS file, run `node engine/stores/generate.mjs`.

Canonical parcel record (keys are stable; missing values are None, never absent):
    id, pin, county, municipality, gis_acres,
    owner {name,address,city,state,zip}, site {address,city,state,zip},
    school, prop_class, zoning ({code,text} | None), pre {current,previous},
    legal_description,
    assessment { current {assessed,sev,taxable}, detail {<backend-specific>} },
    source_backend
"""
from __future__ import annotations

from typing import Optional

CANONICAL_PARCEL_KEYS = (
    "id", "pin", "county", "municipality", "gis_acres", "owner", "site", "school",
    "prop_class", "zoning", "pre", "legal_description", "assessment", "source_backend",
)


def canonical_parcel(
    *,
    pin=None,
    id=None,
    county=None,
    municipality=None,
    gis_acres=None,
    owner=None,
    site=None,
    school=None,
    prop_class=None,
    zoning=None,
    pre=None,
    legal_description=None,
    assessment_current=None,
    assessment_detail=None,
    source_backend=None,
) -> dict:
    """Build a canonical parcel record. The SINGLE definition of the shape — every
    ParcelStore implementation (PV + ZIP) constructs its result through this so the two
    backends stay byte-shape-identical. `owner`/`site`/`pre`/`assessment_current` are
    merged over their full-key defaults so callers can pass partial dicts."""
    owner = owner or {}
    site = site or {}
    pre = pre or {}
    cur = assessment_current or {}
    return {
        "id": id,
        "pin": pin,
        "county": county,
        "municipality": municipality,
        "gis_acres": gis_acres,
        "owner": {
            "name": owner.get("name"), "address": owner.get("address"),
            "city": owner.get("city"), "state": owner.get("state"), "zip": owner.get("zip"),
        },
        "site": {
            "address": site.get("address"), "city": site.get("city"),
            "state": site.get("state"), "zip": site.get("zip"),
        },
        "school": school,
        "prop_class": prop_class,
        "zoning": zoning,
        "pre": {"current": pre.get("current"), "previous": pre.get("previous")},
        "legal_description": legal_description,
        "assessment": {
            "current": {"assessed": cur.get("assessed"), "sev": cur.get("sev"), "taxable": cur.get("taxable")},
            "detail": assessment_detail or {},
        },
        "source_backend": source_backend,
    }


def tenant_predicate(column: Optional[str], tenant: Optional[str]):
    """Row-level tenant scoping for ParcelStore queries (C1 / DIC-582). Returns
    `(sql_fragment, params)` to append to a query's WHERE clause:

      - no `column` configured (single-tenant deployment) -> ('', []), no scoping;
      - `column` configured with a `tenant` -> (' AND <column> = %s', [tenant]);
      - `column` configured but NO tenant -> raises (FAIL CLOSED — an un-scoped query
        on a multi-tenant table would return another county's rows; §4.13).

    `column` is configuration (e.g. 'pg.county'), never user input, so interpolating it
    is safe."""
    if not column:
        return "", []
    if not tenant:
        raise ValueError(
            "ParcelStore: tenant column %r is configured but no tenant was given "
            "(fail-closed; would otherwise leak across tenants)" % column
        )
    return " AND " + column + " = %s", [tenant]


class ParcelStore:
    """Interface: return a canonical parcel record by the backend's reference key
    (pin for ZIP-local, integer id for DICE/VBC). Implementations live per-backend."""

    def get_parcel(self, ref) -> Optional[dict]:
        raise NotImplementedError
