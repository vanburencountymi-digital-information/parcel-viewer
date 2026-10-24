"""POST /report-error (emailed to the county), POST /client-errors (the browser error beacon)
and POST /csp-report (Content-Security-Policy violation reports)."""

import logging

from django.conf import settings
from django.http import HttpResponse
from rest_framework import status
from rest_framework.permissions import AllowAny
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from common.error_logging_client import ErrorLoggingClient, get_error_logging_client
from common.logging_setup import safe_for_log
from common.throttles import check_limits, limits_for
from common.validation import HttpError, ParamSource, json_body, validate
from feedback.csp import ACCEPTED_TYPES, BadReport, parse_reports
from feedback.email import send_report
from feedback.params import ClientErrorReport, DataErrorReport

log = logging.getLogger("parcel_viewer.routers.feedback")
beacon_log = logging.getLogger("parcel_viewer.routers.client_errors")
csp_log = logging.getLogger("parcel_viewer.routers.csp_reports")

USER_AGENT_REPORT_CHARS = 500
USER_AGENT_LOG_CHARS = 200
# A real report is well under 2 KB (the full policy string is most of it); a Reporting API
# batch holds a few. Anything bigger is refused unread.
CSP_REPORT_MAX_BYTES = 16 * 1024


def _no_content() -> HttpResponse:
    """A 204 with no body and no Content-Type (a 204 has no body, so FastAPI sent no type)."""
    response = HttpResponse(status=status.HTTP_204_NO_CONTENT)
    del response["Content-Type"]
    return response


class PublicPostView(APIView):
    """Public and unauthenticated. Limits are checked after validation (check_limits)."""

    authentication_classes = []
    permission_classes = [AllowAny]
    throttle_classes = []


class ReportErrorView(PublicPostView):
    """
    Every accepted report emails the county inbox, so it is capped per client
    (REPORT_ERROR_RATE_LIMIT, 5/hour) and overall (REPORT_ERROR_GLOBAL_LIMIT, 100/day)
    against flooding from rotating addresses (DIC-1852).
    """

    def __init__(self, errors: ErrorLoggingClient | None = None, **kwargs: object) -> None:
        """Takes an optional error client (injected in tests)."""
        super().__init__(**kwargs)
        self.errors = errors or get_error_logging_client()

    def post(self, request: Request) -> Response:
        """Emails the report: {"ok": true}, or 503 when email isn't set up, or 502 when sending fails."""
        report = validate(DataErrorReport, json_body(request), ParamSource.BODY)
        check_limits(
            request,
            self,
            limits_for(
                "report_error", settings.REPORT_ERROR_RATE_LIMIT, settings.REPORT_ERROR_GLOBAL_LIMIT
            ),
        )
        if not settings.SMTP_HOST:
            return Response(
                {"ok": False, "error": "email_not_configured"},
                status=status.HTTP_503_SERVICE_UNAVAILABLE,
            )
        try:
            user_agent = (request.headers.get("User-Agent") or "")[:USER_AGENT_REPORT_CHARS]
            send_report(report, user_agent)
        except Exception as exc:  # noqa: BLE001 — SMTP internals never reach a public caller
            log.exception("report-error: sending email failed")
            self.errors.report_exception(exc, tags={"operation": "report_error_email"})
            return Response(
                {"ok": False, "error": "send_failed"}, status=status.HTTP_502_BAD_GATEWAY
            )
        return Response({"ok": True})


class ClientErrorView(PublicPostView):
    """
    The viewer's error beacon posts browser errors here, so breakage seen only in a
    tester's browser shows up in the server logs (DIC-1879). Nothing is stored. Capped per
    client (20/minute) and overall (5000/day).
    """

    def post(self, request: Request) -> HttpResponse:
        """Logs the report as one warning line. Returns 204 with no body."""
        report = validate(ClientErrorReport, json_body(request), ParamSource.BODY)
        check_limits(
            request,
            self,
            limits_for(
                "client_errors",
                settings.CLIENT_ERROR_RATE_LIMIT,
                settings.CLIENT_ERROR_GLOBAL_LIMIT,
            ),
        )
        # Everything here comes from the browser: one line each, so it can't forge log lines.
        kind = safe_for_log(report.kind, 30)
        line = safe_for_log(report.line if report.line is not None else "", 12)
        column = safe_for_log(report.column if report.column is not None else "", 12)
        message = safe_for_log(report.message)
        source = safe_for_log(report.source or "", 300)
        page = safe_for_log(report.page or "", 300)
        user_agent = safe_for_log(request.headers.get("User-Agent") or "", USER_AGENT_LOG_CHARS)
        beacon_log.warning(
            "browser %s: %s (%s:%s:%s on %s)",
            kind,
            message,
            source,
            line,
            column,
            page,
            extra={
                "browser_error_kind": kind,
                "browser_error_source": source,
                "browser_error_line": line,
                "browser_page": page,
                "user_agent": user_agent,
            },
        )
        return _no_content()


class CspReportView(PublicPostView):
    """
    The CSP's report sink (DIC-2556): nginx sends the policy with `report-uri /api/csp-report`
    (report-to later, see infra/nginx.viewer.conf), so a violation in a tester's browser shows
    up in the server logs, one warning each, before the policy is enforced. Nothing is stored.
    Takes both report formats (feedback.csp), at most CSP_REPORT_MAX_BYTES. Capped per client
    and overall, like /client-errors (CSP_REPORT_RATE_LIMIT, CSP_REPORT_GLOBAL_LIMIT).
    """

    def post(self, request: Request) -> HttpResponse:
        """Logs each violation as one warning line. Returns 204 with no body."""
        declared = request.META.get("CONTENT_LENGTH") or "0"
        if not declared.isdigit() or int(declared) > CSP_REPORT_MAX_BYTES:
            raise HttpError(413, "Report too large")
        content_type = (request.content_type or "").split(";", 1)[0].strip().lower()
        if content_type not in ACCEPTED_TYPES:
            raise HttpError(415, "Unsupported report type")
        raw = request.body
        if len(raw) > CSP_REPORT_MAX_BYTES:
            raise HttpError(413, "Report too large")
        try:
            violations = parse_reports(raw, content_type)
        except BadReport as exc:
            raise HttpError(400, "Not a CSP report") from exc
        check_limits(
            request,
            self,
            limits_for(
                "csp_reports", settings.CSP_REPORT_RATE_LIMIT, settings.CSP_REPORT_GLOBAL_LIMIT
            ),
        )
        user_agent = safe_for_log(request.headers.get("User-Agent") or "", USER_AGENT_LOG_CHARS)
        for v in violations:
            csp_log.warning(
                "csp %s: %s blocked %s (%s:%s:%s on %s)",
                v.disposition or "violation",
                v.directive,
                v.blocked,
                v.source,
                v.line,
                v.column,
                v.document,
                extra={
                    "csp_directive": v.directive,
                    "csp_blocked": v.blocked,
                    "csp_source": v.source,
                    "csp_line": v.line,
                    "csp_disposition": v.disposition,
                    "browser_page": v.document,
                    "user_agent": user_agent,
                },
            )
        return _no_content()
