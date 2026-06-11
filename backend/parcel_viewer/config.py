"""Parcel Viewer backend configuration (env-driven)."""

import os
from pathlib import Path

from dotenv import load_dotenv

# Load repo-root .env when running outside Docker
load_dotenv(Path(__file__).resolve().parents[2] / ".env", override=False)


def _env(name: str, default: str = "") -> str:
    return os.environ.get(name, default)


DATABASE_URL = _env(
    "PV_DATABASE_URL",
    _env(
        "PS_DATABASE_URL",
        "postgresql://parcel_studio_app:CHANGE_ME@localhost:5432/postgres?sslmode=require",
    ),
)

MARTIN_PUBLIC_URL = _env("PV_MARTIN_PUBLIC_URL", _env("PS_MARTIN_PUBLIC_URL", "/tiles"))

MAP_CENTER = [-86.03, 42.24]
MAP_BOUNDS = [-86.33, 42.06, -85.76, 42.43]
