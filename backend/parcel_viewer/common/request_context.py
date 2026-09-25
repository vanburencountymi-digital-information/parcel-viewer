"""Request ids and the access log (ADR 0001).

Every request gets an id: the caller's `X-Request-ID` if it looks safe (nginx sends
one), otherwise a new random one. The id is echoed back in the response header and
attached to every log line written while the request runs, so a tester's report
("it broke, here's the id") leads straight to the matching server logs.

One access-log line per request records method, path, status and duration. The query
string is left out on purpose: search terms can be owner names.

This file is kept identical in backend/parcel_viewer/common/ and map-buddy/backend/common/
(a test checks it).
"""

import contextvars
import logging
import re
import time
import uuid

_request_id: contextvars.ContextVar[str | None] = contextvars.ContextVar("request_id", default=None)

# Accept only short, plain ids from callers, so a header can't inject text into logs.
_SAFE_ID = re.compile(r"^[A-Za-z0-9._-]{8,64}$")

access_log = logging.getLogger("access")


def current_request_id() -> str | None:
    """Returns the id of the request being handled, or None outside a request."""
    return _request_id.get()


def _header(scope: dict, name: bytes) -> str:
    for key, value in scope.get("headers") or []:
        if key == name:
            return value.decode("latin-1")
    return ""


def _client_ip(scope: dict) -> str:
    # Behind nginx the real client arrives as X-Real-IP; otherwise the socket peer.
    real = _header(scope, b"x-real-ip")
    if real:
        return real
    client = scope.get("client")
    return client[0] if client else ""


def _level_for(status: int, path: str, quiet_paths: tuple[str, ...]) -> int:
    if status >= 500:
        return logging.ERROR
    if status >= 400 and status != 404:
        return logging.WARNING  # includes 429s: rate-limit hits should be visible
    if path in quiet_paths:
        return logging.DEBUG  # uptime checks would otherwise drown the log
    return logging.INFO


class RequestContextMiddleware:
    """ASGI middleware: assigns the request id, adds the `X-Request-ID` response
    header, and writes the access-log line. Plain ASGI (not BaseHTTPMiddleware) so
    streamed responses such as Map Buddy's chat pass through untouched."""

    def __init__(self, app, quiet_paths: tuple[str, ...] = ("/health",)) -> None:
        self.app = app
        self.quiet_paths = quiet_paths

    async def __call__(self, scope, receive, send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        incoming = _header(scope, b"x-request-id")
        request_id = incoming if _SAFE_ID.match(incoming) else uuid.uuid4().hex
        token = _request_id.set(request_id)
        started = time.perf_counter()
        status = 500

        async def send_with_id(message) -> None:
            nonlocal status
            if message["type"] == "http.response.start":
                status = message["status"]
                message["headers"] = list(message.get("headers") or []) + [
                    (b"x-request-id", request_id.encode("latin-1"))
                ]
            await send(message)

        try:
            await self.app(scope, receive, send_with_id)
        except Exception:
            status = 500
            raise
        finally:
            duration_ms = round((time.perf_counter() - started) * 1000, 1)
            path = scope.get("path", "")
            method = scope.get("method", "")
            access_log.log(
                _level_for(status, path, self.quiet_paths),
                "%s %s %s %sms",
                method, path, status, duration_ms,
                extra={
                    "http_method": method,
                    "path": path,
                    "status": status,
                    "duration_ms": duration_ms,
                    "client_ip": _client_ip(scope),
                },
            )
            _request_id.reset(token)
