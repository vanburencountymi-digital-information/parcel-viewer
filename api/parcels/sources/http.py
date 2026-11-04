"""The `api` parcel source: parcel-data-api over HTTP with a Knox service token (DIC-2802).

SKELETON. The contract isn't published yet (DIC-2779). The transport is real: auth,
timeouts, one retry, and errors mapped onto today's 503s (docs/parcel-data-api-client-plan.md,
sections 3 and 4). Every path, query parameter and response shape below is a placeholder
marked TODO(DIC-2779), and phase 2 replaces them with the contract's. Until then
PV_PARCEL_SOURCE stays `sql` everywhere.

The token lives only on the server: it's set on the one pooled client, whose base URL is
fixed, and it's never logged. The browser keeps calling the viewer's own /api/ routes.
"""

from __future__ import annotations

import logging
import random
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlsplit

import httpx
from django.conf import settings
from django.core.exceptions import ImproperlyConfigured

from common.request_context import current_request_id
from parcels.sources import CohortResult
from parcels.sources.errors import (
    ParcelSourceBusy,
    ParcelSourceRejected,
    ParcelSourceUnavailable,
)

log = logging.getLogger(__name__)

# httpx logs every request URL at INFO, and a search URL carries what people typed (owner
# names). The viewer's access log leaves query strings out on purpose, so these do too.
for _name in ("httpx", "httpcore"):
    logging.getLogger(_name).setLevel(logging.WARNING)

# TODO(DIC-2779): placeholder paths, relative to PARCEL_DATA_API_BASE. Replace each with
# the contract's endpoint; nothing here is agreed.
PATHS = {
    "parcel": "TODO-parcels/{parcel_id}",
    "bbox": "TODO-parcels",
    "search": "TODO-search",
    "history": "TODO-parcels/{parcel_id}/history",
    "nearest_road": "TODO-nearest-road",
    "streetview": "TODO-parcels/{parcel_id}/streetview-target",
    "cohort": "TODO-cohort",
    "geographies": "TODO-geographies/{kind}",
    "health": "TODO-health",
}

# Upstream statuses worth one retry: a gateway or the service briefly unavailable.
RETRY_STATUSES = frozenset({502, 503, 504})
LOOPBACK_HOSTS = frozenset({"localhost", "127.0.0.1", "::1"})
USER_AGENT = "parcel-viewer-api"


@dataclass(frozen=True)
class Timeouts:
    """Seconds. All well under gunicorn's request timeout."""

    connect: float = 2.0
    read: float = 5.0
    cohort: float = 15.0
    health: float = 2.0


class ApiParcelSource:
    """Parcel reads from parcel-data-api (ADR 0018, section 7)."""

    def __init__(
        self,
        base_url: str,
        token: str,
        *,
        token_prefix: str = "Token",
        timeouts: Timeouts | None = None,
        health_cache_s: float = 15.0,
        transport: httpx.BaseTransport | None = None,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        """
        Takes the API's base URL and the service token, plus the Knox prefix, timeouts, how
        long a health answer is reused, and (for tests) a transport and a sleep function.
        """
        if not token:
            raise ImproperlyConfigured("PARCEL_DATA_API_TOKEN must be set.")
        self.base_url = _check_base_url(base_url)
        self.timeouts = timeouts or Timeouts()
        self._sleep = sleep
        self._health_cache_s = health_cache_s
        self._health: tuple[float, bool] | None = None
        self._health_lock = threading.Lock()
        # One pooled, thread-safe client per process: /parcels runs on every map move, so
        # keep-alive saves a TLS handshake per call.
        self._client = httpx.Client(
            base_url=self.base_url,
            headers={"Authorization": f"{token_prefix} {token}", "User-Agent": USER_AGENT},
            timeout=httpx.Timeout(self.timeouts.read, connect=self.timeouts.connect),
            follow_redirects=False,  # a redirect could carry the token to another host
            transport=transport,
        )

    @classmethod
    def from_settings(cls) -> ApiParcelSource:
        """Returns a source built from the PARCEL_DATA_API_* settings."""
        return cls(
            settings.PARCEL_DATA_API_BASE,
            settings.PARCEL_DATA_API_TOKEN,
            token_prefix=settings.PARCEL_DATA_API_TOKEN_PREFIX,
            timeouts=Timeouts(
                connect=settings.PARCEL_DATA_API_CONNECT_TIMEOUT_S,
                read=settings.PARCEL_DATA_API_READ_TIMEOUT_S,
                cohort=settings.PARCEL_DATA_API_COHORT_TIMEOUT_S,
                health=settings.PARCEL_DATA_API_HEALTH_TIMEOUT_S,
            ),
            health_cache_s=settings.PARCEL_DATA_API_HEALTH_CACHE_S,
        )

    def close(self) -> None:
        """Closes the connection pool."""
        self._client.close()

    # --- the reads (TODO(DIC-2779): parameters and response shapes are placeholders) ---

    def get_parcel(self, parcel_id: int) -> dict[str, Any] | None:
        return _row(self._get(PATHS["parcel"].format(parcel_id=parcel_id), allow_404=True))

    def in_bbox(
        self, west: float, south: float, east: float, north: float, limit: int
    ) -> list[dict[str, Any]]:
        params = {"bbox": f"{west},{south},{east},{north}", "limit": limit}
        return _rows(self._get(PATHS["bbox"], params=params))

    def search(self, tokens: list[str], limit: int) -> list[dict[str, Any]]:
        return _rows(self._get(PATHS["search"], params={"q": " ".join(tokens), "limit": limit}))

    def history(self, parcel_id: int, limit: int) -> list[dict[str, Any]]:
        path = PATHS["history"].format(parcel_id=parcel_id)
        return _rows(self._get(path, params={"limit": limit}))

    def nearest_road_point(self, lng: float, lat: float) -> dict[str, Any] | None:
        return _row(self._get(PATHS["nearest_road"], params={"lng": lng, "lat": lat}))

    def streetview_target(self, parcel_id: int) -> dict[str, Any] | None:
        path = PATHS["streetview"].format(parcel_id=parcel_id)
        return _row(self._get(path, allow_404=True))

    def cohort(self, selector: dict[str, Any], limit: int) -> CohortResult:
        body = self._send(
            "POST",
            PATHS["cohort"],
            json={"selector": selector, "limit": limit},
            timeout=self.timeouts.cohort,
            # A POST isn't retried until the contract says the cohort query is idempotent.
            retry=False,
            rejectable=True,
        )
        if not isinstance(body, dict):
            raise _malformed(PATHS["cohort"])
        return CohortResult(
            rows=_rows(body.get("rows")), center=_row(body.get("center")), pin=body.get("pin")
        )

    def geographies(self, kind: str) -> list[dict[str, Any]]:
        return _rows(self._get(PATHS["geographies"].format(kind=kind)))

    def ping(self) -> bool:
        """Returns True if the API's health route answers 2xx. Never raises. The answer is
        reused for a few seconds, so uptime checks don't add load upstream."""
        with self._health_lock:
            now = time.monotonic()
            if self._health and now - self._health[0] < self._health_cache_s:
                return self._health[1]
            try:
                self._send("GET", PATHS["health"], timeout=self.timeouts.health, retry=False)
                ok = True
            except (ParcelSourceUnavailable, ParcelSourceBusy):
                ok = False
            self._health = (now, ok)
            return ok

    # --- transport ---

    def _get(
        self, path: str, *, params: dict[str, Any] | None = None, allow_404: bool = False
    ) -> Any:
        return self._send("GET", path, params=params, retry=True, allow_404=allow_404)

    def _send(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, Any] | None = None,
        json: Any = None,
        timeout: float | None = None,
        retry: bool,
        allow_404: bool = False,
        rejectable: bool = False,
    ) -> Any:
        """
        Takes a request to make. Returns its parsed JSON body, or None for a 404 that
        allow_404 permits. Raises the errors in the plan's section 4.
        """
        if urlsplit(path).scheme or path.startswith("/"):
            # Only relative paths, so every request (and the token) goes to the base URL.
            raise ValueError(f"parcel-data-api paths must be relative: {path!r}")
        headers = {}
        request_id = current_request_id()
        if request_id:
            headers["X-Request-ID"] = request_id
        read = timeout if timeout is not None else self.timeouts.read
        attempts = 2 if retry else 1
        for attempt in range(1, attempts + 1):
            last = attempt == attempts
            try:
                response = self._client.request(
                    method,
                    path,
                    params=params,
                    json=json,
                    headers=headers,
                    timeout=httpx.Timeout(read, connect=self.timeouts.connect),
                )
            except httpx.ConnectError as exc:
                if not last:
                    self._backoff()
                    continue
                log.warning("parcel-data-api unreachable: %s on %s", type(exc).__name__, path)
                raise ParcelSourceUnavailable(path) from exc
            except httpx.ConnectTimeout as exc:
                log.warning("parcel-data-api connect timeout on %s", path)
                raise ParcelSourceUnavailable(path) from exc
            except httpx.TimeoutException as exc:  # read, write or pool timeout
                log.warning("parcel-data-api busy: %s on %s", type(exc).__name__, path)
                raise ParcelSourceBusy(path) from exc
            except httpx.TransportError as exc:  # reset mid-response, protocol error
                log.warning("parcel-data-api unavailable: %s on %s", type(exc).__name__, path)
                raise ParcelSourceUnavailable(path) from exc

            code = response.status_code
            if code in RETRY_STATUSES and not last:
                self._backoff()
                continue
            return self._parse(response, path, allow_404=allow_404, rejectable=rejectable)
        raise AssertionError("unreachable")  # pragma: no cover

    def _parse(
        self, response: httpx.Response, path: str, *, allow_404: bool, rejectable: bool
    ) -> Any:
        """Takes a response. Returns its JSON, None for a permitted 404, or raises."""
        code = response.status_code
        if 200 <= code < 300:
            try:
                return response.json()
            except ValueError as exc:
                raise _malformed(path) from exc
        if code == 404 and allow_404:
            return None
        if code == 429:
            log.warning("parcel-data-api rate limited the viewer on %s", path)
            raise ParcelSourceBusy(path)
        if code in (401, 403):
            # Our misconfiguration (a wrong or expired service token), not an outage.
            log.error("parcel-data-api refused the service token (%s) on %s", code, path)
            raise ParcelSourceUnavailable(path)
        if code == 400 and rejectable:
            raise ParcelSourceRejected(path)
        if code >= 500:
            log.warning("parcel-data-api answered %s on %s", code, path)
        else:
            # The viewer validated the input already, so any other 4xx is a contract mismatch.
            log.error("parcel-data-api answered %s on %s", code, path)
        raise ParcelSourceUnavailable(path)

    def _backoff(self) -> None:
        self._sleep(0.2 + random.uniform(0, 0.1))  # noqa: S311 — jitter, not security


def _check_base_url(base_url: str) -> str:
    """Takes the base URL. Returns it with a trailing slash, or raises if it isn't https
    (plain http is allowed only to a loopback host, for local work and tests)."""
    if not base_url:
        raise ImproperlyConfigured("PARCEL_DATA_API_BASE must be set.")
    parts = urlsplit(base_url)
    if parts.scheme == "https" or (parts.scheme == "http" and parts.hostname in LOOPBACK_HOSTS):
        return base_url.rstrip("/") + "/"
    raise ImproperlyConfigured("PARCEL_DATA_API_BASE must be an https URL.")


def _malformed(path: str) -> ParcelSourceUnavailable:
    log.error("parcel-data-api sent a malformed body on %s", path)
    return ParcelSourceUnavailable(path)


# TODO(DIC-2779): the adapter. Phase 2 maps the contract's JSON onto the database column
# names the presenters and the meter read (parcels/repositories.py). Until then a body is
# taken as already being those rows.
def _row(body: Any) -> dict[str, Any] | None:
    if body is None:
        return None
    if not isinstance(body, dict):
        raise _malformed("row")
    return body


def _rows(body: Any) -> list[dict[str, Any]]:
    if body is None:
        return []
    if not isinstance(body, list) or not all(isinstance(r, dict) for r in body):
        raise _malformed("rows")
    return body
