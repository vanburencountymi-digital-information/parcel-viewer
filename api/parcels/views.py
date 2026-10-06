"""Parcel read routes: property card, bbox parcels, search, history, road snapping, Street View.

Views stay thin (team standard): validate the parameters, call the repository, present.
"""

import math
from typing import Any

from rest_framework import status
from rest_framework.permissions import AllowAny
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.throttling import ScopedRateThrottle
from rest_framework.views import APIView

from common.validation import HttpError, ParamSource, query_params, validate
from parcels import presenters
from parcels.params import (
    BboxQuery,
    HistoryQuery,
    ParcelPath,
    PointQuery,
    SearchQuery,
    StreetViewQuery,
)
from parcels.repositories import MAX_SEARCH_TOKENS, ParcelRepository

BBOX_ERROR = "bbox must be west,south,east,north"
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


def parse_bbox(bbox: str) -> tuple[float, float, float, float]:
    """Takes "west,south,east,north". Returns the four numbers, or raises a 400 when malformed."""
    try:
        west, south, east, north = (float(part) for part in bbox.split(","))
    except ValueError:
        raise HttpError(status.HTTP_400_BAD_REQUEST, BBOX_ERROR) from None
    if not all(math.isfinite(v) for v in (west, south, east, north)):
        raise HttpError(status.HTTP_400_BAD_REQUEST, BBOX_ERROR)
    return west, south, east, north
