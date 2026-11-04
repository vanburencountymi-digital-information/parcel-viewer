"""Parcel read routes: property card, bbox parcels, search, history, road snapping, Street View.

Views stay thin (team standard): validate the parameters, call the parcel source, present.
The source is SQL or parcel-data-api (PV_PARCEL_SOURCE, DIC-2802); the views can't tell.
"""

import logging
import math
import time
from typing import Any

from access.auth import OptionalTokenAuthentication
from access.meter import finish, meter_rows
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
from parcels.repositories import MAX_SEARCH_TOKENS
from parcels.sources import ParcelSource, get_parcel_source
from parcels.sources.errors import ParcelSourceRejected

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
    `parcel_read` rate (THROTTLE_PARCEL_READ) rather than the default anonymous one.
    Routes that send owner/value fields are metered per county (ADR 0015, access.meter); a
    staff token, if sent, exempts the caller and is otherwise ignored."""

    authentication_classes = [OptionalTokenAuthentication]
    permission_classes = [AllowAny]
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "parcel_read"

    def __init__(self, source: ParcelSource | None = None, **kwargs: Any) -> None:
        """Takes an optional parcel source (injected in tests)."""
        super().__init__(**kwargs)
        self.source = source or get_parcel_source()

    def query(self, request: Request, model: type[Any]) -> Any:
        """Takes the request and a parameter model. Returns the validated query parameters."""
        names = tuple(model.model_fields)
        return validate(model, query_params(request.query_params, names), ParamSource.QUERY)


class ParcelDetailView(PublicParcelView):
    def get(self, request: Request, parcel_id: str) -> Response:
        """Returns one parcel as a GeoJSON Feature, or 404."""
        path = validate(ParcelPath, {"parcel_id": parcel_id}, ParamSource.PATH)
        row = self.source.get_parcel(path.parcel_id)
        if row is None:
            raise HttpError(status.HTTP_404_NOT_FOUND, NOT_FOUND)
        metered = meter_rows(request, [row])
        return finish(Response(presenters.parcel_feature(row)), metered, 1)


class ParcelHistoryView(PublicParcelView):
    def get(self, request: Request, parcel_id: str) -> Response:
        """Returns the parcel's ledger events, newest first (empty for an unknown parcel)."""
        path = validate(ParcelPath, {"parcel_id": parcel_id}, ParamSource.PATH)
        params = self.query(request, HistoryQuery)
        return Response(
            presenters.history_events(self.source.history(path.parcel_id, params.limit))
        )


class ParcelsInBboxView(PublicParcelView):
    def get(self, request: Request) -> Response:
        """Returns the parcels in a lng/lat box as a FeatureCollection (at most `limit`)."""
        params = self.query(request, BboxQuery)
        west, south, east, north = parse_bbox(params.bbox)
        rows = self.source.in_bbox(west, south, east, north, params.limit)
        metered = meter_rows(request, rows)
        return finish(Response(presenters.feature_collection(rows)), metered, len(rows))


class SearchView(PublicParcelView):
    def get(self, request: Request) -> Response:
        """Returns parcels matching every word of `q` (PIN, owner, street or city), best first."""
        params = self.query(request, SearchQuery)
        tokens = params.q.split()[:MAX_SEARCH_TOKENS]
        if not tokens:
            return Response({"results": []})
        rows = self.source.search(tokens, params.limit)
        metered = meter_rows(request, rows)
        return finish(Response(presenters.search_results(rows)), metered, len(rows))


class NearestRoadView(PublicParcelView):
    def get(self, request: Request) -> Response:
        """Returns the closest point on the nearest road, or the point as given if none."""
        params = self.query(request, PointQuery)
        row = self.source.nearest_road_point(params.lng, params.lat)
        return Response(presenters.nearest_road(row, params.lng, params.lat))


class StreetViewTargetView(PublicParcelView):
    def get(self, request: Request) -> Response:
        """Returns where a Street View camera should stand for a parcel, and what it faces."""
        params = self.query(request, StreetViewQuery)
        return Response(presenters.streetview_target(self.source.streetview_target(params.id)))


class CohortView(PublicParcelView):
    def post(self, request: Request) -> Response:
        """
        Resolves a cohort selector to its parcels for the cohort-analyze capability (DIC-587).
        The database does the spatial selection; the engine core does the aggregation.
        Returns {selector: {type, label, count, center?}, features: [{id, properties}]}.
        """
        body = validate(CohortBody, json_body(request), ParamSource.BODY)
        limit = max(1, min(int(body.limit or 3000), MAX_COHORT_PARCELS))
        selector = body.selector or {}
        try:
            # Validates the selector here, whatever the source, so bad input is a 400
            # before any query or network call; the label comes from it too.
            _, _, resolved = build_predicate(selector, limit)
        except CohortSelectorError as exc:
            raise HttpError(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
        try:
            result = self.source.cohort(selector, limit)
        except ParcelSourceRejected as exc:
            # Anything the source still rejects in the caller's area is the caller's input,
            # so a 400. Outages are 503s.
            log.warning("cohort: the parcel source rejected the selector: %s", exc)
            raise HttpError(status.HTTP_400_BAD_REQUEST, AREA_ERROR) from exc
        rows = result.rows
        if result.pin:
            # Label a buffer by the parcel number people know, not the internal id.
            resolved["label"] = resolved["label"].rsplit(" parcel ", 1)[0] + " parcel " + result.pin
        metered = meter_rows(request, rows)
        return finish(
            Response(presenters.cohort(rows, result.center, resolved)), metered, len(rows)
        )


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
            geographies = self.source.geographies(key)
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
