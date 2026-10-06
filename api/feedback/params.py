"""Request bodies for the feedback routes, with FastAPI's exact constraints (ADR 0012)."""

from typing import Literal

from pydantic import BaseModel, Field


class DataErrorReport(BaseModel):
    pin: str | None = Field(default=None, max_length=64)
    details: str = Field(min_length=1, max_length=5000)
    email: str | None = Field(default=None, max_length=254)


class ClientErrorReport(BaseModel):
    kind: Literal["error", "unhandledrejection"]
    message: str = Field(max_length=500)
    source: str | None = Field(default=None, max_length=300)
    line: int | None = Field(default=None, ge=0)
    column: int | None = Field(default=None, ge=0)
    page: str | None = Field(default=None, max_length=300)
