"""The feedback routes' contract, ported from the FastAPI tests (DIC-1852, DIC-1879)."""

import json
from unittest.mock import create_autospec, patch

from django.core.cache import cache
from django.test import SimpleTestCase, override_settings
from parameterized import parameterized
from rest_framework.test import APIClient

from common.error_logging_client import ErrorLoggingClient

REPORT = {"pin": "80-01-001-001-00", "details": "The owner name is wrong."}
BEACON = {
    "kind": "error",
    "message": "TypeError: x is undefined",
    "source": "/frontend/public/js/map.js",
    "line": 10,
    "column": 3,
    "page": "/demo/",
}


class _ClientTestCase(SimpleTestCase):
    def setUp(self) -> None:
        cache.clear()
        self.addCleanup(cache.clear)
        self.client = APIClient()


@override_settings(SMTP_HOST="smtp.example")
class ReportErrorTests(_ClientTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.errors = create_autospec(ErrorLoggingClient, instance=True)
        patcher = patch("feedback.views.get_error_logging_client", return_value=self.errors)
        patcher.start()
        self.addCleanup(patcher.stop)

    @override_settings(SMTP_HOST="")
    def test_without_smtp_it_says_email_is_not_configured(self) -> None:
        response = self.client.post("/report-error", REPORT, format="json")

        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json(), {"ok": False, "error": "email_not_configured"})

    @patch("feedback.views.send_report", autospec=True)
    def test_a_valid_report_is_sent(self, mock_send) -> None:
        response = self.client.post(
            "/report-error", REPORT, format="json", HTTP_USER_AGENT="TestBrowser/1"
        )

        self.assertEqual(response.json(), {"ok": True})
        report, user_agent = mock_send.call_args.args
        self.assertEqual((report.pin, user_agent), ("80-01-001-001-00", "TestBrowser/1"))

    @patch(
        "feedback.views.send_report",
        autospec=True,
        side_effect=OSError("535 auth failed for gis@smtp.internal"),
    )
    def test_a_send_failure_hides_smtp_details_and_is_reported(self, _mock_send) -> None:
        with self.assertLogs("parcel_viewer.routers.feedback", level="ERROR"):
            response = self.client.post("/report-error", REPORT, format="json")

        self.assertEqual(response.status_code, 502)
        self.assertEqual(response.json(), {"ok": False, "error": "send_failed"})
        self.assertNotIn(b"smtp.internal", response.content)
        self.errors.report_exception.assert_called_once()

    @parameterized.expand(
        [
            ("no_details", {"pin": "1"}),
            ("empty_details", {"details": ""}),
            ("details_too_long", {"details": "x" * 5001}),
            ("pin_too_long", {"pin": "p" * 65, "details": "x"}),
            ("email_too_long", {"email": "e" * 255, "details": "x"}),
        ]
    )
    @patch("feedback.views.send_report", autospec=True)
    def test_invalid_reports_are_rejected_unsent(self, _name, body, mock_send) -> None:
        response = self.client.post("/report-error", body, format="json")

        self.assertEqual(response.status_code, 422)
        mock_send.assert_not_called()

    @patch("feedback.views.send_report", autospec=True)
    def test_one_client_is_limited_to_five_reports_an_hour(self, mock_send) -> None:
        codes = [
            self.client.post("/report-error", REPORT, format="json").status_code for _ in range(6)
        ]

        self.assertEqual(codes, [200] * 5 + [429])
        self.assertEqual(mock_send.call_count, 5)

    @override_settings(REPORT_ERROR_RATE_LIMIT="1/hour", REPORT_ERROR_GLOBAL_LIMIT="2/day")
    @patch("feedback.views.send_report", autospec=True)
    def test_the_global_ceiling_holds_across_clients_and_ignores_rejected_ones(
        self, _mock_send
    ) -> None:
        def post(ip: str) -> int:
            return self.client.post(
                "/report-error", REPORT, format="json", HTTP_X_REAL_IP=ip
            ).status_code

        # Client a's second report is refused per client, so it doesn't spend the global budget.
        self.assertEqual([post("a"), post("a"), post("b"), post("c")], [200, 429, 200, 429])


class ClientErrorTests(_ClientTestCase):
    def test_logs_a_valid_report_and_answers_204_with_no_body(self) -> None:
        with self.assertLogs("parcel_viewer.routers.client_errors", level="WARNING") as logs:
            response = self.client.post(
                "/client-errors", BEACON, format="json", HTTP_USER_AGENT="TestBrowser/1"
            )

        self.assertEqual(response.status_code, 204)
        self.assertEqual(response.content, b"")
        self.assertNotIn("Content-Type", response)
        record = logs.records[-1]
        self.assertIn("TypeError: x is undefined", record.getMessage())
        self.assertEqual(record.browser_error_kind, "error")
        self.assertEqual(record.browser_page, "/demo/")
        self.assertEqual(record.user_agent, "TestBrowser/1")

    def test_a_report_cannot_forge_log_lines(self) -> None:
        forged = {**BEACON, "message": "boom\n2026-09-25 INFO access [x] GET /admin 200"}

        with self.assertLogs("parcel_viewer.routers.client_errors", level="WARNING") as logs:
            self.client.post("/client-errors", forged, format="json")

        self.assertNotIn("\n", logs.records[-1].getMessage())

    @parameterized.expand(
        [
            ("message_too_long", {"message": "x" * 501}),
            ("unknown_kind", {"kind": "warning"}),
            ("negative_line", {"line": -1}),
            ("source_too_long", {"source": "s" * 301}),
        ]
    )
    def test_rejects_bad_reports(self, _name: str, change: dict) -> None:
        response = self.client.post("/client-errors", {**BEACON, **change}, format="json")

        self.assertEqual(response.status_code, 422)

    def test_rate_limited_per_client(self) -> None:
        with self.assertLogs("parcel_viewer.routers.client_errors", level="WARNING"):
            codes = [
                self.client.post("/client-errors", BEACON, format="json").status_code
                for _ in range(21)
            ]

        self.assertEqual(codes[:20], [204] * 20)
        self.assertEqual(codes[20], 429)


LEGACY_CSP = {
    "csp-report": {
        "document-uri": "https://gis.example/demo/?q=SMITH%20JOHN#p=1",
        "referrer": "https://search.example/?q=SMITH",
        "violated-directive": "script-src-elem",
        "effective-directive": "script-src-elem",
        "original-policy": "default-src 'self'; script-src 'self'",
        "disposition": "report",
        "blocked-uri": "https://evil.example/x.js?owner=SMITH",
        "line-number": 12,
        "column-number": 4,
        "source-file": "https://gis.example/assets/scripts-abc.js?v=1",
        "status-code": 200,
        "script-sample": "SMITH JOHN",
    }
}
REPORTING_CSP = [
    {
        "type": "csp-violation",
        "age": 10,
        "url": "https://gis.example/demo/",
        "user_agent": "TestBrowser/1",
        "body": {
            "documentURL": "https://gis.example/demo/?q=SMITH",
            "effectiveDirective": "img-src",
            "blockedURL": "https://tiles.example/1/2/3.png?key=secret",
            "disposition": "report",
            "sample": "",
            "originalPolicy": "img-src 'self'",
            "statusCode": 200,
        },
    },
    {"type": "deprecation", "body": {"id": "x"}},
    {
        "type": "csp-violation",
        "body": {
            "documentURL": "https://gis.example/admin/",
            "effectiveDirective": "script-src-elem",
            "blockedURL": "inline",
            "disposition": "report",
            "lineNumber": 3,
        },
    },
]


class CspReportTests(_ClientTestCase):
    def post(self, body: object, content_type: str, **extra: str):
        raw = body if isinstance(body, (bytes, str)) else json.dumps(body)
        return self.client.post("/csp-report", raw, content_type=content_type, **extra)

    def test_logs_a_legacy_report_without_query_strings_or_samples(self) -> None:
        with self.assertLogs("parcel_viewer.routers.csp_reports", level="WARNING") as logs:
            response = self.post(
                LEGACY_CSP, "application/csp-report", HTTP_USER_AGENT="TestBrowser/1"
            )

        self.assertEqual(response.status_code, 204)
        self.assertEqual(response.content, b"")
        self.assertNotIn("Content-Type", response)
        (record,) = logs.records
        self.assertEqual(record.csp_directive, "script-src-elem")
        self.assertEqual(record.csp_blocked, "https://evil.example/x.js")
        self.assertEqual(record.csp_source, "https://gis.example/assets/scripts-abc.js")
        self.assertEqual(record.csp_line, "12")
        self.assertEqual(record.browser_page, "/demo/")
        self.assertEqual(record.user_agent, "TestBrowser/1")
        self.assertNotIn("SMITH", record.getMessage())
        self.assertNotIn("SMITH", json.dumps(vars(record), default=str))

    def test_logs_each_violation_of_a_reporting_api_batch(self) -> None:
        with self.assertLogs("parcel_viewer.routers.csp_reports", level="WARNING") as logs:
            response = self.post(REPORTING_CSP, "application/reports+json")

        self.assertEqual(response.status_code, 204)
        self.assertEqual(
            [(r.csp_directive, r.csp_blocked, r.browser_page) for r in logs.records],
            [
                ("img-src", "https://tiles.example/1/2/3.png", "/demo/"),
                ("script-src-elem", "inline", "/admin/"),
            ],
        )
        self.assertNotIn("secret", " ".join(r.getMessage() for r in logs.records))

    def test_older_browsers_directive_comes_from_violated_directive(self) -> None:
        report = {
            "csp-report": {"violated-directive": "img-src 'self' data:", "blocked-uri": "data"}
        }

        with self.assertLogs("parcel_viewer.routers.csp_reports", level="WARNING") as logs:
            self.post(report, "application/csp-report")

        self.assertEqual(logs.records[0].csp_directive, "img-src")

    def test_a_report_cannot_forge_log_lines(self) -> None:
        forged = {"csp-report": {**LEGACY_CSP["csp-report"], "blocked-uri": "a\nINFO forged"}}

        with self.assertLogs("parcel_viewer.routers.csp_reports", level="WARNING") as logs:
            self.post(forged, "application/csp-report")

        self.assertNotIn("\n", logs.records[0].getMessage())

    def test_a_batch_is_capped(self) -> None:
        batch = [REPORTING_CSP[0]] * 25

        with self.assertLogs("parcel_viewer.routers.csp_reports", level="WARNING") as logs:
            self.post(batch, "application/reports+json")

        self.assertEqual(len(logs.records), 20)

    @parameterized.expand(
        [
            ("not_json", b"{nope", "application/csp-report", 400),
            ("no_report_object", {"other": 1}, "application/csp-report", 400),
            ("wrong_type", "csp-report=1", "application/x-www-form-urlencoded", 415),
            (
                "too_large",
                {"csp-report": {"blocked-uri": "x" * 20_000}},
                "application/csp-report",
                413,
            ),
        ]
    )
    def test_rejects_what_is_not_a_report(
        self, _name: str, body: object, content_type: str, code: int
    ) -> None:
        self.assertEqual(self.post(body, content_type).status_code, code)

    def test_rate_limited_per_client(self) -> None:
        with self.assertLogs("parcel_viewer.routers.csp_reports", level="WARNING"):
            codes = [self.post(LEGACY_CSP, "application/csp-report").status_code for _ in range(31)]

        self.assertEqual(codes[:30], [204] * 30)
        self.assertEqual(codes[30], 429)
