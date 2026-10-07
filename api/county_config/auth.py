"""The admin guard: a signed-in staff user's Knox token, for a county they may edit (ADR 0013).

The admin views authenticate with Knox only, so `request.user` is the token's user or
anonymous. The shared admin key (PV_ADMIN_TOKEN) is retired here (DIC-2151); the FastAPI
backend keeps it until the cutover. Which counties a staff user may edit is in
accounts.models (superusers: all).
"""

from rest_framework import status
from rest_framework.request import Request

from accounts.models import can_edit_county
from common.validation import HttpError
from county_config import store

SIGN_IN_REQUIRED = "Staff sign-in required."
STAFF_ONLY = "Staff only."
NOT_CONFIGURED = "Config store not configured (set PV_WRITER_DATABASE_URL)."
TRY_AGAIN = "Config store unavailable; try again shortly."


def require_staff(request: Request) -> None:
    """Takes the request. Raises 401 unless a user signed in, and 403 unless they're active staff."""
    user = request.user
    if user is None or not user.is_authenticated:
        raise HttpError(status.HTTP_401_UNAUTHORIZED, SIGN_IN_REQUIRED)
    if not (user.is_active and user.is_staff):
        raise HttpError(status.HTTP_403_FORBIDDEN, STAFF_ONLY)


def require_county(request: Request, county: str) -> None:
    """Takes the request and a county. Raises 403 unless the staff user may edit that county."""
    if not can_edit_county(request.user, county):
        raise HttpError(status.HTTP_403_FORBIDDEN, f"No access to county {county!r}.")


def author(request: Request) -> str:
    """Takes the request. Returns the signed-in user's username: the author of a change."""
    return str(request.user.get_username())


def require_writer(request: Request, county: str) -> store.ConfigStore:
    """
    Takes the request and the county it changes. Checks sign-in and county access first (so
    nobody else ever reaches the writer database), then that the store is configured and not
    backing off after an outage. Returns the store, or raises 401/403/503.
    """
    require_staff(request)
    require_county(request, county)
    if not store.is_configured():
        raise HttpError(status.HTTP_503_SERVICE_UNAVAILABLE, NOT_CONFIGURED)
    try:
        store.backoff.check()
    except store.ConfigStoreUnavailable as exc:
        # The outage was logged when its backoff started: fail fast, don't report again.
        raise HttpError(status.HTTP_503_SERVICE_UNAVAILABLE, TRY_AGAIN) from exc
    return store.ConfigStore()
