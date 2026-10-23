"""GET /environment: what the federal environmental layers say at a point (DIC-2412).

One call for the map-click identify, the Neighborhood Profile and Map Buddy, answered from
our own copy of the data instead of three live queries to federal servers. Flood zones
first; wetlands and soils join it as they're loaded (DIC-2145).
"""

from typing import Any

from pydantic import BaseModel, Field
from rest_framework.permissions import AllowAny
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from common.throttles import ClientScopedThrottle
from common.validation import ParamSource, query_params, validate
from environment.flood import FloodAnswer, flood_at
from environment.models import DatasetLoad

# The data changes when a load runs (monthly at most), so answers can be cached a while.
CACHE_SECONDS = 3600


class PointQuery(BaseModel):
    lng: float = Field(ge=-180, le=180)
    lat: float = Field(ge=-90, le=90)


def _source(load: DatasetLoad | None) -> dict[str, Any] | None:
    if load is None:
        return None
    return {
        "name": load.get_dataset_display(),
        "id": load.source_id or None,
        "effective": load.effective_date.isoformat() if load.effective_date else None,
        "loaded": load.loaded_at.date().isoformat(),
    }


def present_flood(answer: FloodAnswer) -> dict[str, Any]:
    """
    Takes a flood lookup. Returns its JSON: status "mapped" (with FEMA's fields), "unmapped"
    (no FEMA zone at the point, e.g. outside the county), or "not_loaded" (no data yet, so
    callers can fall back to FEMA's own service).
    """
    if answer.load is None:
        return {"status": "not_loaded"}
    z = answer.zone
    if z is None:
        return {"status": "unmapped"}
    return {
        "status": "mapped",
        "zone": z.zone,
        "subtype": z.subtype or None,
        "in_special_flood_hazard_area": z.sfha,
        "base_flood_elevation_ft": z.static_bfe,
        "depth_ft": z.depth,
        "vertical_datum": z.vertical_datum or None,
    }


class EnvironmentView(APIView):
    """Anonymous reads, on the viewer's shared `parcel_read` rate (every map click calls it)."""

    authentication_classes = []
    permission_classes = [AllowAny]
    throttle_classes = [ClientScopedThrottle]
    throttle_scope = "parcel_read"

    def get(self, request: Request) -> Response:
        """Returns the flood zone at lng/lat, and which data answered."""
        params = validate(
            PointQuery, query_params(request.query_params, ("lng", "lat")), ParamSource.QUERY
        )
        flood = flood_at(params.lng, params.lat)
        response = Response(
            {
                "lng": params.lng,
                "lat": params.lat,
                "flood": present_flood(flood),
                "sources": {"flood": _source(flood.load)},
            }
        )
        response["Cache-Control"] = f"public, max-age={CACHE_SECONDS}"
        return response
