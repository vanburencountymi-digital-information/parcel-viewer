"""Request parameters for the parcel routes, with FastAPI's exact constraints (ADR 0012)."""

from typing import Any

from pydantic import BaseModel, Field

# The viewer asks for up to 4,000 parcels per map view (DIC-1872).
MAX_BBOX_PARCELS = 4000


class ParcelPath(BaseModel):
    parcel_id: int


class BboxQuery(BaseModel):
    bbox: str  # west,south,east,north in EPSG:4326; parsed by the view (400 when malformed)
    limit: int = Field(MAX_BBOX_PARCELS, ge=1, le=MAX_BBOX_PARCELS)


class SearchQuery(BaseModel):
    q: str = Field(min_length=2, max_length=100)
    limit: int = Field(10, ge=1, le=50)


class HistoryQuery(BaseModel):
    limit: int = Field(50, ge=1, le=200)


class PointQuery(BaseModel):
    lng: float
    lat: float


class StreetViewQuery(BaseModel):
    id: int


class CohortBody(BaseModel):
    # selector: {type:'explicit', ids:[...]} | {type:'buffer', parcel_id|lng+lat, distance_ft} | ...
    selector: dict[str, Any] = {}
    limit: int = 3000


class GeographiesQuery(BaseModel):
    type: str
