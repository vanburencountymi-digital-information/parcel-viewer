"""FEMA flood zones: reading NFHL features into FloodZone rows, and the lookup at a point.

FEMA's REST service (NFHL MapServer layer 28, Flood Hazard Zones) answers GeoJSON with the
S_FLD_HAZ_AR fields. `load_features` replaces the stored zones in one transaction, so a
lookup never sees a half-loaded county.
"""

import json
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import date
from typing import Any

from django.contrib.gis.geos import GeometryCollection, GEOSGeometry, MultiPolygon, Point, Polygon
from django.db import transaction
from django.db.models import F

from environment.models import WGS84, DatasetLoad, FloodZone

NFHL_LAYER = "https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28"
NFHL_PANELS = "https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/3"
# FEMA writes -9999 where a field has no value.
NO_VALUE = -9000


class FloodDataError(ValueError):
    """The source data isn't usable (nothing to load, or a feature without its zone)."""


def _number(value: Any) -> float | None:
    if value is None or value == "":
        return None
    n = float(value)
    return None if n <= NO_VALUE else n


def _text(value: Any) -> str:
    return "" if value is None else str(value).strip()


def _multipolygon(geometry: dict[str, Any]) -> MultiPolygon:
    geom = GEOSGeometry(json.dumps(geometry), srid=WGS84)
    if not geom.valid:
        geom = geom.make_valid()
    if isinstance(geom, Polygon):
        return MultiPolygon(geom, srid=WGS84)
    if isinstance(geom, MultiPolygon):
        return geom
    # make_valid can return a collection; keep its polygon parts.
    parts: list[Polygon] = []
    if isinstance(geom, GeometryCollection):
        for g in geom:
            if isinstance(g, Polygon):
                parts.append(g)
            elif isinstance(g, MultiPolygon):
                parts.extend(p for p in g if isinstance(p, Polygon))
    if not parts:
        raise FloodDataError("a flood zone has no polygon area")
    return MultiPolygon(*parts, srid=WGS84)


def zone_from_feature(feature: dict[str, Any]) -> FloodZone:
    """Takes one GeoJSON feature from NFHL layer 28. Returns an unsaved FloodZone."""
    props = feature.get("properties") or {}
    zone = _text(props.get("FLD_ZONE"))
    if not zone or not feature.get("geometry"):
        raise FloodDataError("a feature has no FLD_ZONE or no geometry")
    sfha = _text(props.get("SFHA_TF")).upper()
    return FloodZone(
        fld_ar_id=_text(props.get("FLD_AR_ID")),
        zone=zone,
        subtype=_text(props.get("ZONE_SUBTY")),
        sfha=True if sfha == "T" else False if sfha == "F" else None,
        static_bfe=_number(props.get("STATIC_BFE")),
        depth=_number(props.get("DEPTH")),
        vertical_datum=_text(props.get("V_DATUM")),
        dfirm_id=_text(props.get("DFIRM_ID")),
        source_citation=_text(props.get("SOURCE_CIT")),
        geom=_multipolygon(feature["geometry"]),
    )


def load_features(
    features: Iterable[dict[str, Any]],
    *,
    source_url: str,
    source_id: str = "",
    effective_date: date | None = None,
) -> DatasetLoad:
    """
    Replaces the stored flood zones with `features` (GeoJSON features from NFHL layer 28)
    and records the load. All or nothing: a bad feature leaves the previous zones in place.
    """
    zones = [zone_from_feature(f) for f in features]
    if not zones:
        raise FloodDataError("no flood zones to load")
    with transaction.atomic():
        load = DatasetLoad.objects.create(
            dataset=DatasetLoad.FLOOD,
            source_url=source_url,
            source_id=source_id,
            effective_date=effective_date,
            feature_count=len(zones),
        )
        for z in zones:
            z.load = load
        FloodZone.objects.bulk_create(zones, batch_size=200)
        FloodZone.objects.exclude(load=load).delete()
    return load


@dataclass(frozen=True)
class FloodAnswer:
    """The flood lookup at a point: the zone there (None if unmapped), and the data's load."""

    zone: FloodZone | None
    load: DatasetLoad | None


def flood_at(lng: float, lat: float) -> FloodAnswer:
    """
    Takes a WGS84 point. Returns the flood zone there and the load it came from. Where two
    zones overlap (FEMA's polygons sometimes do along boundaries) the more hazardous one
    wins: inside the special flood hazard area first, then the one with a flood elevation.
    """
    load = DatasetLoad.objects.filter(dataset=DatasetLoad.FLOOD).first()
    if load is None:
        return FloodAnswer(zone=None, load=None)
    zone = (
        FloodZone.objects.filter(geom__intersects=Point(lng, lat, srid=WGS84))
        .order_by(F("sfha").desc(nulls_last=True), F("static_bfe").asc(nulls_last=True), "id")
        .first()
    )
    return FloodAnswer(zone=zone, load=load)
