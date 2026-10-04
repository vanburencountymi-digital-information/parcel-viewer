"""Error monitoring with Sentry (ADR 0001).

The only module that imports `sentry_sdk`, so switching or adding a monitoring vendor
never touches the calling code (the same pattern as dice-document-pipeline-api).

`init_error_monitoring` is safe to call unconditionally: with no `SENTRY_DSN` (local,
test, CI) Sentry does nothing. The DSN is set only in staging and production, from
Secret Manager, with `SENTRY_ENVIRONMENT` naming which.

Unhandled exceptions are reported automatically by Sentry's FastAPI integration.
Exceptions the code catches and recovers from are reported with
`ErrorLoggingClient.report_exception`, so a recurring failure can't hide behind a
friendly fallback message.

This file is kept identical in backend/parcel_viewer/common/ and map-buddy/backend/common/
(a test checks it).
"""

import os

import sentry_sdk

from .request_context import current_request_id

# Request data that can carry personal information: search terms (owner names) in
# query strings, cookies, and request bodies. Never sent to Sentry.
_DROPPED_REQUEST_KEYS = ("query_string", "cookies", "data")


def scrub_event(event: dict, _hint: dict) -> dict:
    """Takes a Sentry event; returns it without query strings, cookies or bodies,
    and tagged with the current request id."""
    request = event.get("request")
    if isinstance(request, dict):
        for key in _DROPPED_REQUEST_KEYS:
            request.pop(key, None)
        url = request.get("url")
        if isinstance(url, str) and "?" in url:
            request["url"] = url.split("?", 1)[0]
    request_id = current_request_id()
    if request_id:
        event.setdefault("tags", {})["request_id"] = request_id
    return event


def init_error_monitoring(service: str, release: str) -> None:
    """Takes the service name and release version; starts Sentry (a no-op without
    SENTRY_DSN)."""
    sentry_sdk.init(
        dsn=os.getenv("SENTRY_DSN", ""),
        environment=os.getenv("SENTRY_ENVIRONMENT", "development"),
        release=release,
        send_default_pii=False,
        traces_sample_rate=float(os.getenv("SENTRY_TRACES_SAMPLE_RATE", "0")),
        before_send=scrub_event,
    )
    sentry_sdk.set_tag("service", service)


class ErrorLoggingClient:
    """Reports exceptions that the code caught and recovered from."""

    def report_exception(self, exc: BaseException, *, tags: dict[str, str]) -> None:
        """Takes the exception and tags for grouping (e.g. {"operation": "explain"});
        returns nothing."""
        sentry_sdk.capture_exception(exc, tags=tags)


_client = ErrorLoggingClient()


def get_error_logging_client() -> ErrorLoggingClient:
    """FastAPI dependency: returns the shared client. Tests override it with a mock
    (`app.dependency_overrides`)."""
    return _client
