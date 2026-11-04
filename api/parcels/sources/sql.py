"""The `sql` parcel source: today's SQL against the PARCELS database, unchanged (DIC-2802).

It wraps `ParcelRepository`, which holds the SQL, and takes over the two cohort details
that used to sit in the view: building the predicate, and turning a PostGIS rejection of
the caller's area into ParcelSourceRejected. Outages still raise Django's database errors,
which common.exceptions maps to its 503s as before.
"""

from __future__ import annotations

from typing import Any

from django.db import DataError, InternalError

from common.enums import DatabaseAlias
from parcels.cohort_query import GEOGRAPHY_SOURCES, build_predicate
from parcels.repositories import ParcelRepository
from parcels.sources import CohortResult
from parcels.sources.errors import ParcelSourceRejected


class SqlParcelSource:
    """Parcel reads through ParcelRepository's raw SQL (ADR 0006)."""

    def __init__(self, repository: ParcelRepository | None = None) -> None:
        """Takes an optional repository (injected in tests)."""
        self.repository = repository or ParcelRepository()

    def get_parcel(self, parcel_id: int) -> dict[str, Any] | None:
        return self.repository.get_parcel(parcel_id)

    def in_bbox(
        self, west: float, south: float, east: float, north: float, limit: int
    ) -> list[dict[str, Any]]:
        return self.repository.in_bbox(west, south, east, north, limit)

    def search(self, tokens: list[str], limit: int) -> list[dict[str, Any]]:
        return self.repository.search(tokens, limit)

    def history(self, parcel_id: int, limit: int) -> list[dict[str, Any]]:
        return self.repository.history(parcel_id, limit)

    def nearest_road_point(self, lng: float, lat: float) -> dict[str, Any] | None:
        return self.repository.nearest_road_point(lng, lat)

    def streetview_target(self, parcel_id: int) -> dict[str, Any] | None:
        return self.repository.streetview_target(parcel_id)

    def cohort(self, selector: dict[str, Any], limit: int) -> CohortResult:
        """Takes an accepted selector and a cap. Returns the cohort, or raises ParcelSourceRejected."""
        predicate, params, resolved = build_predicate(selector, limit)
        try:
            rows = self.repository.cohort(predicate, params, limit)
            center = self.repository.cohort_center(predicate, params)
            pin = None
            parcel_id = selector.get("parcel_id")
            if resolved.get("type") == "buffer" and parcel_id is not None:
                pin = self.repository.parcel_number(int(parcel_id))
        except (DataError, InternalError) as exc:
            # Behind build_predicate's validation (DIC-1872): anything PostGIS still rejects
            # in the caller's area is the caller's input. Outages stay database errors (503).
            raise ParcelSourceRejected(type(exc).__name__) from exc
        return CohortResult(rows=rows, center=center, pin=pin)

    def geographies(self, kind: str) -> list[dict[str, Any]]:
        return self.repository.geographies(GEOGRAPHY_SOURCES[kind])

    def ping(self) -> bool:
        from common.services import ping_database

        return ping_database(DatabaseAlias.PARCELS)
