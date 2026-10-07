"""Request bodies for the sign-in routes, validated with FastAPI-style 422s (ADR 0012)."""

from pydantic import BaseModel, Field


class LoginBody(BaseModel):
    # Django's username limit; a password cap so a huge body can't make hashing expensive.
    username: str = Field(min_length=1, max_length=150)
    password: str = Field(min_length=1, max_length=1024)
