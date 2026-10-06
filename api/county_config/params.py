"""Request parameters for the config routes, with FastAPI's exact shapes (ADR 0012)."""

from typing import Any

from django.conf import settings
from pydantic import BaseModel, Field


def _default_county() -> str:
    return str(settings.DEFAULT_COUNTY)


class CountyQuery(BaseModel):
    county: str = Field(default_factory=_default_county)


class DraftBody(BaseModel):
    payload: dict[str, Any]
    author: str | None = None


class PublishBody(BaseModel):
    author: str | None = None
    note: str | None = None


class RollbackBody(BaseModel):
    version: int
    author: str | None = None
