import asyncio
from unittest import TestCase
from unittest.mock import MagicMock, create_autospec, patch

from fastapi.testclient import TestClient
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

    @patch("urllib.request.urlopen", side_effect=OSError("upstream timeout"))
    def test_wms_proxy_upstream_failure_is_logged_not_reported(self, _mock_urlopen) -> None:
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
