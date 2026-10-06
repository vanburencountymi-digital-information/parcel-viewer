"""The WMS proxy's fetch, ported from backend/app/main.py with its hardening (DIC-1880, DIC-1872).

It fetches a caller-supplied URL, so beyond the host allowlist it must not follow
redirects (a 30x to any host would bypass the allowlist), must not pass through content a
browser would render as a page on our origin, and must bound what it reads.
"""

import logging
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlparse, urlunparse

from common.logging_setup import safe_for_log

log = logging.getLogger("parcel_viewer.api")

ALLOWED_WMS_HOSTS = (
    "hazards.fema.gov",
    "fwspublicservices.wim.usgs.gov",
    "sdmdataaccess.nrcs.usda.gov",
    "elevation.nationalmap.gov",
)
ALLOWED_TYPES = (
    "application/json",
    "application/geo+json",
    "application/xml",
    "text/xml",
    "application/vnd.ogc.",
    "text/plain",
    "image/png",
    "image/jpeg",
    "image/gif",
)
USER_AGENT = "ParcelViewer/1.0"
TIMEOUT_S = 10


@dataclass(frozen=True)
class Fetched:
    """The upstream answer, or the error the caller gets instead (one of the two is set)."""

    content: bytes = b""
    content_type: str = ""
    error: str = ""


class _NoRedirects(urllib.request.HTTPRedirectHandler):
    """Refuses every redirect: urllib then raises HTTPError with the 30x status."""

    def redirect_request(self, *args: Any, **kwargs: Any) -> None:
        return None


_opener = urllib.request.build_opener(_NoRedirects)


def wms_target(url: str) -> str | None:
    """Takes the caller's URL. Returns it rebuilt as https on an allowed host, or None if not allowed."""
    parsed = urlparse(url)
    host = (parsed.hostname or "").lower()
    if parsed.scheme != "https" or parsed.username or parsed.password:
        return None
    try:
        port = parsed.port
    except ValueError:
        return None
    if port not in (None, 443):
        return None
    if not any(host == h or host.endswith("." + h) for h in ALLOWED_WMS_HOSTS):
        return None
    return urlunparse(("https", host, parsed.path or "/", "", parsed.query, ""))


def fetch(target: str, max_bytes: int) -> Fetched:
    """
    Takes an allowed target URL and a size cap. Returns the upstream content and type, or
    an error message. Third-party outages (FEMA, USFWS, NRCS) aren't our bugs: they're
    logged as warnings, not sent to Sentry, and the upstream body is never passed back.
    """
    host = safe_for_log(urlparse(target).hostname or "", 100)  # for log lines only
    try:
        request = urllib.request.Request(target, headers={"User-Agent": USER_AGENT})
        with _opener.open(request, timeout=TIMEOUT_S) as response:
            content = response.read(max_bytes + 1)
            content_type = response.headers.get("Content-Type", "text/xml")
    except urllib.error.HTTPError as exc:
        log.warning("wms-proxy upstream %s returned %s", host, exc.code)
        return Fetched(error=f"upstream map service returned {exc.code}")
    except Exception:  # noqa: BLE001 — any failure upstream is a 502 for the caller
        log.warning("wms-proxy upstream request failed: %s", host, exc_info=True)
        return Fetched(error="upstream map service unavailable")

    if len(content) > max_bytes:
        log.warning("wms-proxy upstream %s response over %s bytes", host, max_bytes)
        return Fetched(error="upstream response too large")
    base_type = content_type.split(";", 1)[0].strip().lower()
    if not base_type.startswith(ALLOWED_TYPES):
        log.warning(
            "wms-proxy upstream %s sent unexpected type %s", host, safe_for_log(base_type, 100)
        )
        return Fetched(error="unexpected upstream content")
    return Fetched(content=content, content_type=content_type)
