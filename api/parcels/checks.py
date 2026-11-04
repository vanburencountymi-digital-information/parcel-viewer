"""Startup checks for the parcel source settings (DIC-2802)."""

from typing import Any
from urllib.parse import urlsplit

from django.conf import settings
from django.core.checks import Error, register

from parcels.sources import API, SOURCES
from parcels.sources.http import LOOPBACK_HOSTS


@register()
def parcel_source_settings(app_configs: Any = None, **kwargs: Any) -> list[Error]:
    """Fails startup when PV_PARCEL_SOURCE is unknown, or `api` lacks its URL or token."""
    source = settings.PARCEL_SOURCE
    if source not in SOURCES:
        return [Error(f"PV_PARCEL_SOURCE must be one of {', '.join(SOURCES)}.", id="parcels.E001")]
    if source != API:
        return []
    errors = []
    base = urlsplit(settings.PARCEL_DATA_API_BASE)
    if not (base.scheme == "https" or (base.scheme == "http" and base.hostname in LOOPBACK_HOSTS)):
        errors.append(
            Error(
                "PARCEL_DATA_API_BASE must be an https URL when PV_PARCEL_SOURCE=api.",
                id="parcels.E002",
            )
        )
    if not settings.PARCEL_DATA_API_TOKEN:
        errors.append(
            Error("PARCEL_DATA_API_TOKEN must be set when PV_PARCEL_SOURCE=api.", id="parcels.E003")
        )
    return errors
