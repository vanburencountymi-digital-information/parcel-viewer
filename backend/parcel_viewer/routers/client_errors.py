"""Browser error reports (DIC-1879, ADR 0001).

The viewer's error beacon (frontend/public/js/pv-error-beacon.js) posts JavaScript
errors here, so breakage that only happens in a tester's browser shows up in the
server logs. Nothing is stored; each report becomes one warning log line.

Public and unauthenticated, so it is rate limited per client and overall, and every
field is length-capped.
"""

import logging
import os
from typing import Literal

from fastapi import APIRouter, Request, Response
from pydantic import BaseModel, Field

from parcel_viewer.common.logging_setup import safe_for_log
from parcel_viewer.ratelimit import global_key, limiter

log = logging.getLogger(__name__)
router = APIRouter()

CLIENT_ERROR_RATE_LIMIT = os.getenv("CLIENT_ERROR_RATE_LIMIT", "20/minute")
CLIENT_ERROR_GLOBAL_LIMIT = os.getenv("CLIENT_ERROR_GLOBAL_LIMIT", "5000/day")


class ClientErrorReport(BaseModel):
    kind: Literal["error", "unhandledrejection"]
    message: str = Field(max_length=500)
    source: str | None = Field(default=None, max_length=300)
    line: int | None = Field(default=None, ge=0)
    column: int | None = Field(default=None, ge=0)
    page: str | None = Field(default=None, max_length=300)


@router.post("/client-errors", status_code=204)
# Per-client limit below the global one, as in feedback.py: requests it rejects never
# use up the global budget.
@limiter.limit(CLIENT_ERROR_GLOBAL_LIMIT, key_func=global_key)
@limiter.limit(CLIENT_ERROR_RATE_LIMIT)
def client_error(report: ClientErrorReport, request: Request) -> Response:
    """Takes one browser error report; logs it and returns 204 (no body)."""
    # Everything here comes from the browser: one line each, so it can't forge log lines.
    kind = safe_for_log(report.kind, 30)
    line = safe_for_log(report.line if report.line is not None else "", 12)
    column = safe_for_log(report.column if report.column is not None else "", 12)
    message = safe_for_log(report.message)
    source = safe_for_log(report.source or "", 300)
    page = safe_for_log(report.page or "", 300)
    user_agent = safe_for_log(request.headers.get("user-agent") or "", 200)
    log.warning(
        "browser %s: %s (%s:%s:%s on %s)",
        kind, message, source, line, column, page,
        extra={
            "browser_error_kind": kind,
            "browser_error_source": source,
            "browser_error_line": line,
            "browser_page": page,
            "user_agent": user_agent,
        },
    )
    return Response(status_code=204)
