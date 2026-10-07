"""The admin guard: a signed-in staff user's Knox token, or (until the cutover) the shared key.

ADR 0013. The admin views authenticate with Knox only, so `request.user` is the token's user
or anonymous. The shared key (PV_ADMIN_TOKEN) is still accepted while
ADMIN_SHARED_KEY_ACCEPTED is on, so the contract harness and the FastAPI-era console keep
working; turning it off retires the key in Django.
"""

import hmac

from django.conf import settings
from rest_framework import status
from rest_framework.request import Request

from common.validation import HttpError
from county_config import store

ADMIN_HEADER = "X-Admin-Token"
# Kept word for word while the shared key is accepted: the contract harness compares it.
ADMIN_REQUIRED = "Admin auth required (interim PV_ADMIN_TOKEN; real auth is DIC-463)."
STAFF_ONLY = "Staff only."
NOT_CONFIGURED = "Config store not configured (set PV_WRITER_DATABASE_URL)."
TRY_AGAIN = "Config store unavailable; try again shortly."


def staff_username(request: Request) -> str | None:
    """Takes the request. Returns the signed-in staff user's username, or None."""
    user = request.user
    if user is not None and user.is_authenticated and user.is_active and user.is_staff:
        return str(user.get_username())
    return None


def _has_shared_key(request: Request) -> bool:
    """
    Takes the request. Returns True if the shared key is accepted and the request carries it.
    With no key configured on the server, nobody has it. The comparison is constant-time, so
    timing can't leak the key (DIC-1853).
    """
    if not settings.ADMIN_SHARED_KEY_ACCEPTED:
        return False
    expected = str(settings.ADMIN_TOKEN or "")
    given = request.headers.get(ADMIN_HEADER) or ""
    return bool(expected) and hmac.compare_digest(given.encode(), expected.encode())


def require_admin(request: Request) -> None:
    """
    Takes the request. Returns if a staff user signed in or the shared key came with it.
    Raises 403 for a signed-in user who isn't staff, else 401.
    """
    if staff_username(request) or _has_shared_key(request):
        return
    if request.user is not None and request.user.is_authenticated:
        raise HttpError(status.HTTP_403_FORBIDDEN, STAFF_ONLY)
    raise HttpError(status.HTTP_401_UNAUTHORIZED, ADMIN_REQUIRED)


def author(request: Request, given: str | None) -> str | None:
    """
    Takes the request and the author its body named. Returns the signed-in staff user's
    username when there is one (a token can't claim to be someone else), else the body's.
    """
    return staff_username(request) or given


def require_writer(request: Request) -> store.ConfigStore:
    """
    Takes the request. Checks admin auth first (so an anonymous caller never reaches the
    writer database), then that the store is configured and not backing off after an outage.
    Returns the store, or raises 401/403/503 as the FastAPI backend did.
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
