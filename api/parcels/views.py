"""Parcel read routes: property card, bbox parcels, search, history, road snapping, Street View.

Views stay thin (team standard): validate the parameters, call the repository, present.
"""

import logging
import math
import time
from typing import Any

from django.db import DataError, InternalError
from rest_framework import status
from rest_framework.permissions import AllowAny
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.throttling import ScopedRateThrottle
from rest_framework.views import APIView

from common.validation import HttpError, ParamSource, json_body, query_params, validate
from parcels import presenters
from parcels.cohort_query import GEOGRAPHY_SOURCES, CohortSelectorError, build_predicate
from parcels.params import (
    BboxQuery,
    CohortBody,
    GeographiesQuery,
    HistoryQuery,
    ParcelPath,
    PointQuery,
    SearchQuery,
    StreetViewQuery,
)
from parcels.repositories import MAX_SEARCH_TOKENS, ParcelRepository

log = logging.getLogger(__name__)

BBOX_ERROR = "bbox must be west,south,east,north"
AREA_ERROR = "that area couldn't be processed"
UNKNOWN_GEOGRAPHY = "unknown geography type"
# The most parcels one cohort may hold, whatever the caller asks for.
MAX_COHORT_PARCELS = 5000
# Named geographies change only when the county data is reloaded (DIC-1872).
GEOGRAPHIES_TTL_S = 600.0
_geographies_cache: dict[str, tuple[float, list[dict[str, Any]]]] = {}
NOT_FOUND = "Parcel not found"


class PublicParcelView(APIView):
    """Anonymous reads. The viewer calls these on every map move, so they share a generous
    `parcel_read` rate (THROTTLE_PARCEL_READ) rather than the default anonymous one."""

    authentication_classes = []
    permission_classes = [AllowAny]
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "parcel_read"

    def __init__(self, repository: ParcelRepository | None = None, **kwargs: Any) -> None:
        """Takes an optional repository (injected in tests)."""
        super().__init__(**kwargs)
        self.repository = repository or ParcelRepository()

    def query(self, request: Request, model: type[Any]) -> Any:
        """Takes the request and a parameter model. Returns the validated query parameters."""
        names = tuple(model.model_fields)
        return validate(model, query_params(request.query_params, names), ParamSource.QUERY)


class ParcelDetailView(PublicParcelView):
    def get(self, request: Request, parcel_id: str) -> Response:
        """Returns one parcel as a GeoJSON Feature, or 404."""
        path = validate(ParcelPath, {"parcel_id": parcel_id}, ParamSource.PATH)
        row = self.repository.get_parcel(path.parcel_id)
        if row is None:
            raise HttpError(status.HTTP_404_NOT_FOUND, NOT_FOUND)
        return Response(presenters.parcel_feature(row))


class ParcelHistoryView(PublicParcelView):
    def get(self, request: Request, parcel_id: str) -> Response:
        """Returns the parcel's ledger events, newest first (empty for an unknown parcel)."""
        path = validate(ParcelPath, {"parcel_id": parcel_id}, ParamSource.PATH)
        params = self.query(request, HistoryQuery)
        return Response(
            presenters.history_events(self.repository.history(path.parcel_id, params.limit))
        )


class ParcelsInBboxView(PublicParcelView):
    def get(self, request: Request) -> Response:
        """Returns the parcels in a lng/lat box as a FeatureCollection (at most `limit`)."""
        params = self.query(request, BboxQuery)
        west, south, east, north = parse_bbox(params.bbox)
        rows = self.repository.in_bbox(west, south, east, north, params.limit)
        return Response(presenters.feature_collection(rows))


class SearchView(PublicParcelView):
    def get(self, request: Request) -> Response:
        """Returns parcels matching every word of `q` (PIN, owner, street or city), best first."""
        params = self.query(request, SearchQuery)
        tokens = params.q.split()[:MAX_SEARCH_TOKENS]
        if not tokens:
            return Response({"results": []})
        return Response(presenters.search_results(self.repository.search(tokens, params.limit)))


class NearestRoadView(PublicParcelView):
    def get(self, request: Request) -> Response:
        """Returns the closest point on the nearest road, or the point as given if none."""
        params = self.query(request, PointQuery)
        row = self.repository.nearest_road_point(params.lng, params.lat)
        return Response(presenters.nearest_road(row, params.lng, params.lat))


class StreetViewTargetView(PublicParcelView):
    def get(self, request: Request) -> Response:
        """Returns where a Street View camera should stand for a parcel, and what it faces."""
        params = self.query(request, StreetViewQuery)
        return Response(presenters.streetview_target(self.repository.streetview_target(params.id)))


class CohortView(PublicParcelView):
    def post(self, request: Request) -> Response:
        """
        Resolves a cohort selector to its parcels for the cohort-analyze capability (DIC-587).
        The database does the spatial selection; the engine core does the aggregation.
        Returns {selector: {type, label, count, center?}, features: [{id, properties}]}.
        """
        body = validate(CohortBody, json_body(request), ParamSource.BODY)
        limit = max(1, min(int(body.limit or 3000), MAX_COHORT_PARCELS))
        try:
            predicate, params, resolved = build_predicate(body.selector or {}, limit)
        except CohortSelectorError as exc:
            raise HttpError(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
        try:
            rows = self.repository.cohort(predicate, params, limit)
            center = self.repository.cohort_center(predicate, params)
            parcel_id = (body.selector or {}).get("parcel_id")
            if resolved.get("type") == "buffer" and parcel_id is not None:
                # Label a buffer by the parcel number people know, not the internal id.
                pin = self.repository.parcel_number(int(parcel_id))
                if pin:
                    resolved["label"] = (
                        resolved["label"].rsplit(" parcel ", 1)[0] + " parcel " + pin
                    )
        except (DataError, InternalError) as exc:
            # Behind build_predicate's validation (DIC-1872): anything PostGIS still rejects
            # in the caller's area is the caller's input, so a 400. Outages are 503s.
            log.warning("cohort: database rejected the selector: %s", type(exc).__name__)
            raise HttpError(status.HTTP_400_BAD_REQUEST, AREA_ERROR) from exc
        return Response(presenters.cohort(rows, center, resolved))


class CohortGeographiesView(PublicParcelView):
    def get(self, request: Request) -> Response:
        """
        Lists the named geographies of one type (subdivision, section, township, school) so
        the viewer can offer them as cohort areas (DIC-588). Cached for 10 minutes.
        """
        params = self.query(request, GeographiesQuery)
        key = params.type.lower()
        source = GEOGRAPHY_SOURCES.get(key)
        if not source:
            raise HttpError(status.HTTP_400_BAD_REQUEST, UNKNOWN_GEOGRAPHY)
        cached = _geographies_cache.get(key)
        if cached and time.monotonic() - cached[0] < GEOGRAPHIES_TTL_S:
            geographies = cached[1]
        else:
            geographies = self.repository.geographies(source)
            _geographies_cache[key] = (time.monotonic(), geographies)
        # The type is echoed as the caller wrote it, as FastAPI does.
        return Response({"type": params.type, "geographies": geographies})


def parse_bbox(bbox: str) -> tuple[float, float, float, float]:
    """Takes "west,south,east,north". Returns the four numbers, or raises a 400 when malformed."""
    try:
        west, south, east, north = (float(part) for part in bbox.split(","))
    except ValueError:
        raise HttpError(status.HTTP_400_BAD_REQUEST, BBOX_ERROR) from None
    if not all(math.isfinite(v) for v in (west, south, east, north)):
        raise HttpError(status.HTTP_400_BAD_REQUEST, BBOX_ERROR)
    return west, south, east, north
