"""Error responses shaped like the FastAPI backend's (ADR 0011).

- A lost or refused database connection is an outage, not a bug: 503
  {"error": "database unavailable, try again"}, logged as a warning (DIC-1872).
- A statement timeout or no free pooled connection is load: 503 {"error": "database busy, try again"}.
- A rate limit is {"error": "Rate limit exceeded: ..."} (slowapi's shape).
- A wrong method is {"detail": "Method Not Allowed"}; an unknown path {"detail": "Not Found"};
  an unhandled error plain text "Internal Server Error", never the exception (DIC-1855).
"""

import logging
from typing import Any

from django.db import OperationalError
from django.http import HttpRequest, HttpResponse, JsonResponse
from psycopg.errors import QueryCanceled
from psycopg_pool import PoolTimeout
from rest_framework import status
from rest_framework.exceptions import MethodNotAllowed
from rest_framework.response import Response
from rest_framework.views import exception_handler

log = logging.getLogger("parcel_viewer.api")

DATABASE_BUSY = {"error": "database busy, try again"}
DATABASE_UNAVAILABLE = {"error": "database unavailable, try again"}


def _is_busy(exc: BaseException) -> bool:
    """Takes a database error. Returns True for a statement timeout or an exhausted pool."""
    cause = exc.__cause__ or exc.__context__
    return isinstance(exc, QueryCanceled | PoolTimeout) or isinstance(
        cause, QueryCanceled | PoolTimeout
    )


def api_exception_handler(exc: Exception, context: dict[str, Any]) -> Response | None:
    """DRF's handler, with the FastAPI backend's answers for the cases above."""
    request = context.get("request")
    path = request.path_info if request is not None else ""
    if isinstance(exc, OperationalError | QueryCanceled | PoolTimeout):
        if _is_busy(exc):
            log.warning("database busy: %s on %s", type(exc).__name__, path)
            return Response(DATABASE_BUSY, status=status.HTTP_503_SERVICE_UNAVAILABLE)
        log.warning("database unavailable: %s on %s", type(exc).__name__, path)
        return Response(DATABASE_UNAVAILABLE, status=status.HTTP_503_SERVICE_UNAVAILABLE)
    if isinstance(exc, MethodNotAllowed):
        return Response({"detail": "Method Not Allowed"}, status=status.HTTP_405_METHOD_NOT_ALLOWED)
    response = exception_handler(exc, context)
    if response is not None and response.status_code == status.HTTP_429_TOO_MANY_REQUESTS:
        response.data = {"error": str(response.data.get("detail", ""))}
    return response


def not_found(request: HttpRequest, exception: Exception | None = None) -> HttpResponse:
    """Django's 404 for an unknown path, as FastAPI answered it."""
    return JsonResponse({"detail": "Not Found"}, status=status.HTTP_404_NOT_FOUND)


def server_error(request: HttpRequest) -> HttpResponse:
    """Django's 500, as FastAPI answered it: plain text, no details."""
    return HttpResponse(
        "Internal Server Error",
        status=status.HTTP_500_INTERNAL_SERVER_ERROR,
        content_type="text/plain; charset=utf-8",
    )
