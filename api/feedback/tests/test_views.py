"""The feedback routes' contract, ported from the FastAPI tests (DIC-1852, DIC-1879)."""

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
