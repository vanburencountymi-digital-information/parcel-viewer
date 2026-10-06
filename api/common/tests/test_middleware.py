"""Request ids, the access log and CORS, as the FastAPI backend behaved (ADR 0001, DIC-1852)."""

import logging
from unittest.mock import patch

from django.test import SimpleTestCase
from parameterized import parameterized
from rest_framework.test import APIClient

from common.services import HealthReport

VIEWER = "https://gis.dicemi.org"


@patch("common.views.HealthService.check", autospec=True, return_value=HealthReport(ok=True))
class RequestIdTests(SimpleTestCase):
    def setUp(self) -> None:
        self.client = APIClient()

    def test_generates_an_id_and_returns_it(self, _check) -> None:
        response = self.client.get("/health")

        self.assertRegex(response["X-Request-ID"], r"^[0-9a-f]{32}$")

    def test_keeps_a_safe_caller_id(self, _check) -> None:
        response = self.client.get("/health", HTTP_X_REQUEST_ID="nginx-abc123")

        self.assertEqual(response["X-Request-ID"], "nginx-abc123")

    @parameterized.expand(
        [("too_short", "abc"), ("newline", "abcdefgh\nINFO forged"), ("spaces", "a b c d e f g h")]
    )
    def test_replaces_an_unsafe_caller_id(self, _check, _name: str, bad_id: str) -> None:
        response = self.client.get("/health", HTTP_X_REQUEST_ID=bad_id)

        self.assertNotEqual(response["X-Request-ID"], bad_id)

    def test_access_log_has_the_fields_and_no_query_string(self, _check) -> None:
        with self.assertLogs("access", level="DEBUG") as logs:
            self.client.get("/parcels?bbox=owner-name-search", HTTP_X_REAL_IP="203.0.113.9")

        record = logs.records[-1]
        self.assertEqual(record.path, "/parcels")
        self.assertEqual(record.client_ip, "203.0.113.9")
        self.assertNotIn("owner-name", record.getMessage())

    def test_health_checks_are_logged_quietly(self, _check) -> None:
        with self.assertLogs("access", level="DEBUG") as logs:
            self.client.get("/health")

        self.assertEqual(logs.records[-1].levelno, logging.DEBUG)


class CorsTests(SimpleTestCase):
    def setUp(self) -> None:
        self.client = APIClient()

    def _preflight(self, origin: str, method: str = "GET", headers: str | None = None):
        extra = {"HTTP_ORIGIN": origin, "HTTP_ACCESS_CONTROL_REQUEST_METHOD": method}
        if headers is not None:
            extra["HTTP_ACCESS_CONTROL_REQUEST_HEADERS"] = headers
        return self.client.options("/health", **extra)

    def test_the_viewer_origin_may_preflight_without_credentials(self) -> None:
        response = self._preflight(VIEWER, "PUT", "content-type, x-admin-token")

        self.assertEqual((response.status_code, response.content), (200, b"OK"))
        self.assertEqual(response["Access-Control-Allow-Origin"], VIEWER)
        self.assertEqual(response["Access-Control-Allow-Methods"], "GET, POST, PUT")
        self.assertNotIn("Access-Control-Allow-Credentials", response)

    @parameterized.expand(
        [
            ("foreign_origin", "https://evil.example", "GET", None, b"Disallowed CORS origin"),
            ("bad_method", VIEWER, "DELETE", None, b"Disallowed CORS method"),
            ("bad_header", VIEWER, "GET", "x-secret", b"Disallowed CORS headers"),
        ]
    )
    def test_disallowed_preflights_are_400s(self, _name, origin, method, headers, body) -> None:
        response = self._preflight(origin, method, headers)

        self.assertEqual((response.status_code, response.content), (400, body))

    @patch("common.views.HealthService.check", autospec=True, return_value=HealthReport(ok=True))
    def test_a_simple_request_mirrors_only_an_allowed_origin(self, _check) -> None:
        allowed = self.client.get("/health", HTTP_ORIGIN=VIEWER)
        foreign = self.client.get("/health", HTTP_ORIGIN="https://evil.example")

        self.assertEqual(allowed["Access-Control-Allow-Origin"], VIEWER)
        self.assertEqual(allowed["Access-Control-Expose-Headers"], "X-Request-ID")
        self.assertNotIn("Access-Control-Allow-Origin", foreign)

    def test_a_plain_options_request_is_a_405(self) -> None:
        response = self.client.options("/health")

        self.assertEqual(response.status_code, 405)
        self.assertEqual(response.json(), {"detail": "Method Not Allowed"})
