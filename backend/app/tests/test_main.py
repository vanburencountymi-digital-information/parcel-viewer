import asyncio
from unittest import TestCase
from unittest.mock import MagicMock, create_autospec, patch

import urllib.error
from email.message import Message

from fastapi.testclient import TestClient
from parameterized import parameterized
from psycopg_pool import PoolTimeout

from app import main
from parcel_viewer.common.error_logging_client import ErrorLoggingClient, get_error_logging_client


class HealthTests(TestCase):
    def setUp(self) -> None:
        self.client = TestClient(main.app)

    @patch("app.main.health_check", autospec=True, return_value=True)
    def test_ok_when_database_answers(self, _mock_health) -> None:
        response = self.client.get("/health")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"status": "ok", "db": True})
        self.assertIn("x-request-id", response.headers)

    @patch("app.main.health_check", autospec=True, return_value=False)
    def test_503_when_database_is_down(self, _mock_health) -> None:
        response = self.client.get("/health")

        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json(), {"status": "degraded", "db": False})


class ErrorReportingTests(TestCase):
    def setUp(self) -> None:
        self.errors = create_autospec(ErrorLoggingClient, instance=True)
        main.app.dependency_overrides[get_error_logging_client] = lambda: self.errors
        self.client = TestClient(main.app)

    def tearDown(self) -> None:
        main.app.dependency_overrides.clear()

    @patch("app.main._get_store", autospec=True, side_effect=RuntimeError("writer db down"))
    @patch("app.main.config_store.is_configured", autospec=True, return_value=True)
    def test_config_store_failure_is_reported(self, _mock_configured, _mock_store) -> None:
        response = self.client.get("/config/vanburen/draft")

        self.assertEqual(response.status_code, 503)
        self.assertNotIn("writer db down", response.text)  # no internals to the caller
        self.errors.report_exception.assert_called_once()
        self.assertEqual(self.errors.report_exception.call_args.kwargs["tags"], {"operation": "config_store"})

    @patch("app.main._discover_layers", autospec=True, side_effect=RuntimeError("boom"))
    def test_layer_discovery_failure_is_reported(self, _mock_discover) -> None:
        response = self.client.get("/admin/discover/layers")

        self.assertEqual(response.status_code, 500)
        self.errors.report_exception.assert_called_once()
        self.assertEqual(self.errors.report_exception.call_args.kwargs["tags"], {"operation": "discover_layers"})

    @patch("app.main._wms_opener.open", side_effect=OSError("upstream timeout"))
    def test_wms_proxy_upstream_failure_is_logged_not_reported(self, _mock_open) -> None:
        with self.assertLogs("parcel_viewer.api", level="WARNING") as logs:
            response = self.client.get("/wms-proxy", params={"url": "https://hazards.fema.gov/x"})

        self.assertEqual(response.status_code, 502)
        self.assertIn("wms-proxy upstream request failed", logs.output[-1])
        self.errors.report_exception.assert_not_called()  # third-party outages stay out of Sentry


class DbOverloadTests(TestCase):
    def test_pool_timeout_is_logged_as_a_warning(self) -> None:
        request = MagicMock()
        request.url.path = "/parcels"

        with self.assertLogs("parcel_viewer.api", level="WARNING") as logs:
            response = asyncio.run(main._db_overloaded(request, PoolTimeout("no connection")))

        self.assertEqual(response.status_code, 503)
        self.assertIn("database busy: PoolTimeout on /parcels", logs.output[-1])


def _upstream(body: bytes, content_type: str) -> MagicMock:
    """A fake urllib response usable as a context manager."""
    resp = MagicMock()
    resp.__enter__.return_value = resp
    resp.read.side_effect = lambda n=-1: body if n < 0 else body[:n]
    resp.headers = {"Content-Type": content_type}
    return resp


class WmsProxyHardeningTests(TestCase):
    """CodeQL py/full-ssrf (DIC-1880): the proxy must not become a way to reach other
    hosts or to serve arbitrary content from our origin."""

    def setUp(self) -> None:
        from parcel_viewer.ratelimit import limiter
        limiter.reset()
        self.client = TestClient(main.app)

    @parameterized.expand([
        ("plain_http", "http://hazards.fema.gov/arcgis/x"),
        ("other_host", "https://evil.example/x"),
        ("lookalike_host", "https://hazards.fema.gov.evil.example/x"),
        ("userinfo", "https://user:pw@hazards.fema.gov/x"),
        ("odd_port", "https://hazards.fema.gov:8443/x"),
        ("internal", "https://169.254.169.254/latest/meta-data"),
    ])
    def test_rejects_urls_off_the_allowlist(self, _name: str, url: str) -> None:
        with patch("app.main._wms_opener.open") as mock_open:
            response = self.client.get("/wms-proxy", params={"url": url})

        self.assertEqual(response.status_code, 403)
        mock_open.assert_not_called()

    @patch("app.main._wms_opener.open")
    def test_passes_map_data_through(self, mock_open) -> None:
        mock_open.return_value = _upstream(b'{"features": []}', "application/json; charset=utf-8")

        response = self.client.get("/wms-proxy", params={"url": "https://hazards.fema.gov/arcgis/x?f=json"})

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"features": []})
        self.assertEqual(response.headers["x-content-type-options"], "nosniff")
        requested = mock_open.call_args.args[0].full_url
        self.assertEqual(requested, "https://hazards.fema.gov/arcgis/x?f=json")

    @patch("app.main._wms_opener.open")
    def test_refuses_html_from_upstream(self, mock_open) -> None:
        mock_open.return_value = _upstream(b"<script>alert(1)</script>", "text/html")

        response = self.client.get("/wms-proxy", params={"url": "https://hazards.fema.gov/x"})

        self.assertEqual(response.status_code, 502)
        self.assertNotIn("script", response.text)

    @patch("app.main._WMS_MAX_BYTES", 10)
    @patch("app.main._wms_opener.open")
    def test_caps_the_response_size(self, mock_open) -> None:
        mock_open.return_value = _upstream(b"x" * 11, "text/plain")

        response = self.client.get("/wms-proxy", params={"url": "https://hazards.fema.gov/x"})

        self.assertEqual(response.status_code, 502)

    @patch("app.main._wms_opener.open")
    def test_does_not_follow_or_reflect_redirects_and_errors(self, mock_open) -> None:
        headers = Message()
        headers["Location"] = "http://169.254.169.254/"
        mock_open.side_effect = urllib.error.HTTPError("https://hazards.fema.gov/x", 302, "Found", headers, None)

        response = self.client.get("/wms-proxy", params={"url": "https://hazards.fema.gov/x"})

        self.assertEqual(response.status_code, 502)
        self.assertNotIn("169.254", response.text)

    def test_the_opener_refuses_redirects(self) -> None:
        handler = main._NoRedirects()

        self.assertIsNone(handler.redirect_request(None, None, 302, "Found", {}, "https://evil.example/"))
