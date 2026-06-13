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

# ── Data-error report email (Report a data error tool) ──────────────────────
# Reports are emailed to the county GIS inbox. All values are env-driven; if
# PV_SMTP_HOST is unset the endpoint reports "email_not_configured" (503) and
# the feature degrades gracefully until credentials are provisioned.
SMTP_HOST     = _env("PV_SMTP_HOST")
SMTP_PORT     = int(_env("PV_SMTP_PORT", "587"))
SMTP_USER     = _env("PV_SMTP_USER")
SMTP_PASSWORD = _env("PV_SMTP_PASSWORD")
SMTP_STARTTLS = _env("PV_SMTP_STARTTLS", "true").lower() != "false"
REPORT_TO     = _env("PV_REPORT_TO", "gis@vanburencountymi.gov")
REPORT_FROM   = _env("PV_REPORT_FROM")  # defaults to SMTP_USER at send time

MAP_CENTER = [-86.03, 42.24]
MAP_BOUNDS = [-86.33, 42.06, -85.76, 42.43]
