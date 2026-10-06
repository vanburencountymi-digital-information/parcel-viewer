"""Response shapes for the parcel routes, exactly as the FastAPI backend builds them (ADR 0011).

Each function names the keys it returns (an allowlist), except where FastAPI returns the
whole projected row: the row is then bounded by the SQL's column list, which is the allowlist.
"""

import datetime
import json
from typing import Any

# Which tax roll the assessed_value_yr0..yr4 history ends at (DIC-1878). The table doesn't
# record it, so it's inferred from when the assessing data was loaded: Michigan's roll for
# year Y is final once the March Board of Review ends, so a load from April onward carries
# roll Y and a load in January-March still carries roll Y-1.
ROLL_FINAL_MONTH = 4


def roll_year_for_load(loaded_at: datetime.datetime | None) -> int | None:
    """Takes when the assessing data was loaded. Returns the roll year it carries, or None."""
    if loaded_at is None:
        return None
    return loaded_at.year if loaded_at.month >= ROLL_FINAL_MONTH else loaded_at.year - 1


def row_to_feature(row: dict[str, Any]) -> dict[str, Any]:
    """Takes a row with a `geojson` column. Returns a GeoJSON Feature (the row minus geojson as properties)."""
    raw = row.pop("geojson", None)
    geometry = json.loads(raw) if raw else None
    return {"type": "Feature", "id": row.get("id"), "geometry": geometry, "properties": row}


def feature_collection(rows: list[dict[str, Any]]) -> dict[str, Any]:
    """Takes bbox rows. Returns a GeoJSON FeatureCollection."""
    return {"type": "FeatureCollection", "features": [row_to_feature(r) for r in rows]}


def parcel_feature(row: dict[str, Any]) -> dict[str, Any]:
    """
    Takes the full parcel row. Returns its Feature with the viewer's derived properties:
    pin, gis_acres (geodesic area when known), PCOMBINED, roll_year, and ISO timestamps.
    """
    row["pin"] = row["parcel_no"]
    row["gis_acres"] = row["computed_acres"] if row.get("computed_acres") else row["acres"]
    row["PCOMBINED"] = row["prop_street"]
    row["roll_year"] = roll_year_for_load(row.get("assessing_loaded_at"))
    for key in ("created_at", "updated_at", "assessing_loaded_at"):
        if row.get(key) is not None:
            row[key] = row[key].isoformat()
    return row_to_feature(row)


def search_results(rows: list[dict[str, Any]]) -> dict[str, Any]:
    """Takes search rows. Returns {"results": [...]} with each match's bbox in lng/lat."""
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


def history_events(rows: list[dict[str, Any]]) -> dict[str, Any]:
    """Takes ledger rows. Returns {"events": [...]} with ids and timestamps as strings."""
    for r in rows:
        r["event_id"] = str(r["event_id"])
        timestamp = r.get("event_timestamp")
        r["event_timestamp"] = timestamp.isoformat() if timestamp is not None else None
        if r.get("closure_error") is not None:
            r["closure_error"] = float(r["closure_error"])
    return {"events": rows}


def nearest_road(row: dict[str, Any] | None, lng: float, lat: float) -> dict[str, Any]:
    """Takes the snapped row (or None) and the asked point. Returns the snapped point, or the point as given."""
    if not row or row.get("lng") is None:
        return {"lng": lng, "lat": lat, "snapped": False}
    return {"lng": row["lng"], "lat": row["lat"], "snapped": True}


def streetview_target(row: dict[str, Any] | None) -> dict[str, Any]:
    """
    Takes the Street View row. Returns where the camera stands (the nearest road, else the
    anchor itself) and what it looks at, or {"ok": False} for an unknown parcel.
    """
    if not row or row.get("anchor_lng") is None:
        return {"ok": False}
    on_road = row.get("road_lng") is not None
    viewpoint_keys = ("road_lng", "road_lat") if on_road else ("anchor_lng", "anchor_lat")
    return {
        "ok": True,
        "viewpoint": [row[key] for key in viewpoint_keys],
        "lookAt": [row["anchor_lng"], row["anchor_lat"]],
        "address": row.get("address"),
        "hasAddress": bool(row.get("has_address")),
    }
