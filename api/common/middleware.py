"""Request ids, the access log and CORS, behaving exactly as the FastAPI backend (ADR 0011).

The id, access-log levels and safe-id rule come from common/request_context.py, which is
kept identical to the FastAPI and Map Buddy copies; Django runs WSGI, so it gets this
middleware instead of that module's ASGI one. CORS reproduces Starlette's CORSMiddleware
with the FastAPI settings (DIC-1852), down to the preflight bodies.
"""

import time
import uuid
from collections.abc import Callable

from django.conf import settings
from django.http import HttpRequest, HttpResponse

from common.request_context import _SAFE_ID, _level_for, _request_id, access_log

QUIET_PATHS = ("/health",)

# Starlette's CORS-safelisted request headers, always allowed in a preflight.
SAFELISTED_HEADERS = {"Accept", "Accept-Language", "Content-Language", "Content-Type"}
PREFLIGHT_VARY = (
    "Origin, Access-Control-Request-Method, Access-Control-Request-Headers, "
    "Access-Control-Request-Private-Network"
)


class RequestIdMiddleware:
    """
    Gives every request an id (the caller's X-Request-ID if it looks safe, else a new one),
    echoes it in the X-Request-ID response header, stamps it on every log line written
    while the request runs, and writes one access-log line. The query string is left out
    of the log on purpose: search terms can be owner names.
    """

    def __init__(self, get_response: Callable[[HttpRequest], HttpResponse]) -> None:
        self.get_response = get_response

    def __call__(self, request: HttpRequest) -> HttpResponse:
        incoming = request.headers.get("X-Request-ID", "")
        request_id = incoming if _SAFE_ID.match(incoming) else uuid.uuid4().hex
        token = _request_id.set(request_id)
        started = time.perf_counter()
        status = 500
        try:
            response = self.get_response(request)
            status = response.status_code
            response["X-Request-ID"] = request_id
            return response
        finally:
            duration_ms = round((time.perf_counter() - started) * 1000, 1)
            client_ip = request.headers.get("X-Real-IP") or request.META.get("REMOTE_ADDR", "")
            # path_info: the path without the /api mount (PV_SCRIPT_NAME), as FastAPI logs it.
            path = request.path_info
            access_log.log(
                _level_for(status, path, QUIET_PATHS),
                "%s %s %s %sms",
                request.method,
                path,
                status,
                duration_ms,
                extra={
                    "http_method": request.method,
                    "path": path,
                    "status": status,
                    "duration_ms": duration_ms,
                    "client_ip": client_ip,
                },
            )
            _request_id.reset(token)


class CorsMiddleware:
    """
    Starlette's CORSMiddleware as the FastAPI app configured it: the listed origins only,
    no credentials, GET/POST/PUT, the Content-Type and X-Admin-Token headers, and
    X-Request-ID exposed. A preflight is answered here ("OK", or 400 "Disallowed CORS ...").
    """

    def __init__(self, get_response: Callable[[HttpRequest], HttpResponse]) -> None:
        self.get_response = get_response
        self.allow_origins = list(settings.CORS_ORIGINS)
        self.allow_methods = list(settings.CORS_ALLOW_METHODS)
        allowed = sorted(SAFELISTED_HEADERS | set(settings.CORS_ALLOW_HEADERS))
        self.allow_headers = [h.lower() for h in allowed]
        self.preflight_headers = {
            "Vary": PREFLIGHT_VARY,
            "Access-Control-Allow-Methods": ", ".join(self.allow_methods),
            "Access-Control-Max-Age": "600",
            "Access-Control-Allow-Headers": ", ".join(allowed),
        }
        self.expose_headers = ", ".join(settings.CORS_EXPOSE_HEADERS)

    def __call__(self, request: HttpRequest) -> HttpResponse:
        origin = request.headers.get("Origin")
        if (
            origin is not None
            and request.method == "OPTIONS"
            and "Access-Control-Request-Method" in request.headers
        ):
            return self._preflight(request, origin)
        response = self.get_response(request)
        if origin is not None:
            if self.expose_headers:
                response["Access-Control-Expose-Headers"] = self.expose_headers
            if origin in self.allow_origins:
                response["Access-Control-Allow-Origin"] = origin
            _add_vary(response, "Origin")
        return response

    def _preflight(self, request: HttpRequest, origin: str) -> HttpResponse:
        """Takes a preflight and its origin. Returns Starlette's answer: "OK", or 400 naming the failures."""
        headers = dict(self.preflight_headers)
        failures: list[str] = []
        if origin in self.allow_origins:
            headers["Access-Control-Allow-Origin"] = origin
        else:
            failures.append("origin")
        if request.headers["Access-Control-Request-Method"] not in self.allow_methods:
            failures.append("method")
        requested_headers = request.headers.get("Access-Control-Request-Headers")
        if requested_headers is not None:
            for header in (h.lower() for h in requested_headers.split(",")):
                if header.strip() not in self.allow_headers:
                    failures.append("headers")
                    break
        if request.headers.get("Access-Control-Request-Private-Network") is not None:
            failures.append("private-network")

        if failures:
            response = HttpResponse(
                "Disallowed CORS " + ", ".join(failures),
                status=400,
                content_type="text/plain; charset=utf-8",
            )
        else:
            response = HttpResponse("OK", status=200, content_type="text/plain; charset=utf-8")
        for name, value in headers.items():
            response[name] = value
        return response


def _add_vary(response: HttpResponse, value: str) -> None:
    """Takes a response and a header name. Appends it to Vary, as Starlette does."""
    existing = response.get("Vary")
    response["Vary"] = f"{existing}, {value}" if existing else value
