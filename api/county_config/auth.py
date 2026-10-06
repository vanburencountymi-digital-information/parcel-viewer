"""The interim admin guard: one shared key (PV_ADMIN_TOKEN) until Knox and staff login (ADR 0008)."""

import hmac

from django.conf import settings
from rest_framework import status
from rest_framework.request import Request

from common.validation import HttpError
from county_config import store

ADMIN_HEADER = "X-Admin-Token"
ADMIN_REQUIRED = "Admin auth required (interim PV_ADMIN_TOKEN; real auth is DIC-463)."
NOT_CONFIGURED = "Config store not configured (set PV_WRITER_DATABASE_URL)."
TRY_AGAIN = "Config store unavailable; try again shortly."


def require_admin(request: Request) -> None:
    """
    Takes the request. Raises 401 unless it carries the admin key. With no key configured on
    the server, everyone is refused. The comparison is constant-time, so timing can't leak
    the key (DIC-1853).
    """
    expected = str(settings.ADMIN_TOKEN or "")
    given = request.headers.get(ADMIN_HEADER) or ""
    if not expected or not hmac.compare_digest(given.encode(), expected.encode()):
        raise HttpError(status.HTTP_401_UNAUTHORIZED, ADMIN_REQUIRED)


def require_writer(request: Request) -> store.ConfigStore:
    """
    Takes the request. Checks the admin key first (so an anonymous caller never reaches the
    writer database), then that the store is configured and not backing off after an outage.
    Returns the store, or raises 401/503 as the FastAPI backend did.
    """
    require_admin(request)
    if not store.is_configured():
        raise HttpError(status.HTTP_503_SERVICE_UNAVAILABLE, NOT_CONFIGURED)
    try:
        store.backoff.check()
    except store.ConfigStoreUnavailable as exc:
        # The outage was logged when its backoff started: fail fast, don't report again.
        raise HttpError(status.HTTP_503_SERVICE_UNAVAILABLE, TRY_AGAIN) from exc
    return store.ConfigStore()
