"""Where parcel data comes from: one seam for every parcel read (DIC-2802).

Views call `get_parcel_source()` and never see SQL or HTTP. `PV_PARCEL_SOURCE` picks the
implementation:
- `sql` (default): today's SQL against the PARCELS database (`parcels.sources.sql`);
- `api`: `parcel-data-api` over HTTP with a Knox service token (`parcels.sources.http`).

Rows keep the database's column names whichever source answers, so the presenters and
ADR 0015's meter don't change. See docs/parcel-data-api-client-plan.md.
"""

from __future__ import annotations

import threading
from dataclasses import dataclass
from typing import Any, Protocol

from django.conf import settings

SQL = "sql"
API = "api"
SOURCES = (SQL, API)


@dataclass(frozen=True)
class CohortResult:
    """A resolved cohort: its rows, the centre of their extent, and a buffer parcel's PIN."""

    rows: list[dict[str, Any]]
    center: dict[str, Any] | None
    # The PIN of a buffer selector's parcel, for its label; None for other selectors.
    pin: str | None = None


class ParcelSource(Protocol):
    """Every parcel read the viewer's routes make (docs/parcel-data-api-needs.md, section 2)."""

    def get_parcel(self, parcel_id: int) -> dict[str, Any] | None:
        """Takes a parcel id. Returns its full row (with geojson), or None if absent or archived."""
        ...

    def in_bbox(
        self, west: float, south: float, east: float, north: float, limit: int
    ) -> list[dict[str, Any]]:
        """Takes a lng/lat bounding box and a row cap. Returns feature rows (with geojson)."""
        ...

    def search(self, tokens: list[str], limit: int) -> list[dict[str, Any]]:
        """Takes search words and a row cap. Returns matching rows, best match first."""
        ...

    def history(self, parcel_id: int, limit: int) -> list[dict[str, Any]]:
        """Takes a parcel id and a row cap. Returns its ledger events, newest first."""
        ...

    def nearest_road_point(self, lng: float, lat: float) -> dict[str, Any] | None:
        """Takes a lng/lat point. Returns the closest point on the nearest road, or None."""
        ...

    def streetview_target(self, parcel_id: int) -> dict[str, Any] | None:
        """Takes a parcel id. Returns its Street View anchor, road point and address point."""
        ...

    def cohort(self, selector: dict[str, Any], limit: int) -> CohortResult:
        """
        Takes a selector that cohort_query.build_predicate has already accepted, and a cap.
        Returns the cohort. Raises ParcelSourceRejected if the source can't process the area.
        """
        ...

    def geographies(self, kind: str) -> list[dict[str, Any]]:
        """Takes a key of cohort_query.GEOGRAPHY_SOURCES. Returns [{id, name}] by name."""
        ...

    def ping(self) -> bool:
        """Returns True if the source answers (for /health)."""
        ...


_lock = threading.Lock()
_api_source: ParcelSource | None = None


def get_parcel_source() -> ParcelSource:
    """Returns the parcel source PV_PARCEL_SOURCE names. The HTTP one is built once per
    process, so its connection pool is shared; the SQL one is stateless and cheap."""
    if settings.PARCEL_SOURCE == API:
        global _api_source
        with _lock:
            if _api_source is None:
                from parcels.sources.http import ApiParcelSource

                _api_source = ApiParcelSource.from_settings()
            return _api_source
    from parcels.sources.sql import SqlParcelSource

    return SqlParcelSource()


def reset_parcel_source() -> None:
    """Drops the cached HTTP source (tests, and after a settings change)."""
    global _api_source
    with _lock:
        if _api_source is not None:
            close = getattr(_api_source, "close", None)
            if close:
                close()
        _api_source = None
