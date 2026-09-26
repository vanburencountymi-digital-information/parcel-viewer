"""The parcel API's public contract, checked in CI with no database (DIC-1874).

These pin down behaviour that was verified by hand in #16-#31 and could otherwise regress
silently: the admin gate, docs off by default, CORS, input validation before any database
work, no leaked exception text, the /report-error limits, and no blocking `async def`
routes.
"""

import inspect
from unittest import TestCase
from unittest.mock import MagicMock, create_autospec, patch

from fastapi.routing import APIRoute
from fastapi.testclient import TestClient
from parameterized import parameterized

from app import main
from parcel_viewer.common.error_logging_client import ErrorLoggingClient, get_error_logging_client
from parcel_viewer.ratelimit import limiter

TOKEN = "test-admin-token"

# Every admin route, with a body that's valid, so only the gate decides the outcome.
ADMIN_ROUTES = [
    ("get_draft", "GET", "/config/vanburen/draft", None),
    ("put_draft", "PUT", "/config/vanburen/draft", {"payload": {}}),
    ("publish", "POST", "/config/vanburen/publish", {}),
    ("versions", "GET", "/config/vanburen/versions", None),
    ("rollback", "POST", "/config/vanburen/rollback", {"version": 1}),
    ("discover", "GET", "/admin/discover/layers", None),
]
WRITER_ROUTES = [r for r in ADMIN_ROUTES if r[0] != "discover"]


class AdminGateTests(TestCase):
    """Admin routes need the token, checked before any database work."""

    def setUp(self) -> None:
        self.client = TestClient(main.app)
        store = patch("app.main._get_store", autospec=True)
        self.mock_get_store = store.start()
        self.addCleanup(store.stop)
        discover = patch("app.main._discover_layers", autospec=True, return_value=[])
        self.mock_discover = discover.start()
        self.addCleanup(discover.stop)

    @parameterized.expand(ADMIN_ROUTES)
    def test_no_or_wrong_token_is_a_401_with_no_database_work(
        self, _name, method, path, body
    ) -> None:
        with patch("app.main._ADMIN_TOKEN", TOKEN):
            for headers in ({}, {"X-Admin-Token": "wrong"}, {"X-Admin-Token": ""}):
                response = self.client.request(method, path, json=body, headers=headers)

                self.assertEqual(response.status_code, 401, headers)

        self.mock_get_store.assert_not_called()
        self.mock_discover.assert_not_called()

    @parameterized.expand(ADMIN_ROUTES)
    def test_no_token_configured_on_the_server_refuses_everyone(
        self, _name, method, path, body
    ) -> None:
        with patch("app.main._ADMIN_TOKEN", ""):
            response = self.client.request(method, path, json=body, headers={"X-Admin-Token": ""})

        self.assertEqual(response.status_code, 401)

    @parameterized.expand(WRITER_ROUTES)
    def test_valid_token_without_a_config_store_is_a_503(self, _name, method, path, body) -> None:
        with (
            patch("app.main._ADMIN_TOKEN", TOKEN),
            patch("app.main.config_store.is_configured", autospec=True, return_value=False),
        ):
            response = self.client.request(
                method, path, json=body, headers={"X-Admin-Token": TOKEN}
            )

        self.assertEqual(response.status_code, 503)
        self.assertIn("not configured", response.json()["detail"])


class DocsOffTests(TestCase):
    """Interactive docs and the schema are off unless PV_API_DOCS=1 (DIC-1855)."""

    @parameterized.expand([("docs", "/docs"), ("redoc", "/redoc"), ("schema", "/openapi.json")])
    def test_docs_are_not_served_by_default(self, _name, path) -> None:
        response = TestClient(main.app).get(path)

        self.assertEqual(response.status_code, 404)


class CorsTests(TestCase):
    """Only the configured viewer origins may call the API cross-origin, without credentials."""

    def setUp(self) -> None:
        self.client = TestClient(main.app)

    def _preflight(self, origin: str):
        return self.client.options(
            "/health", headers={"Origin": origin, "Access-Control-Request-Method": "GET"}
        )

    def test_the_configured_origin_is_allowed(self) -> None:
        origin = main.CORS_ORIGINS[0]

        response = self._preflight(origin)

        self.assertEqual(response.headers.get("access-control-allow-origin"), origin)
        self.assertNotIn("access-control-allow-credentials", response.headers)

    def test_a_foreign_origin_is_refused(self) -> None:
        response = self._preflight("https://evil.example")

        self.assertNotIn("access-control-allow-origin", response.headers)

    def test_default_origin_is_the_production_viewer(self) -> None:
        self.assertNotIn("*", main.CORS_ORIGINS)
        self.assertFalse(any("localhost" in o for o in main.CORS_ORIGINS))


class InputValidationTests(TestCase):
    """Bad input is a 4xx before the database is touched, never a 500."""

    def setUp(self) -> None:
        self.client = TestClient(main.app)
        pool = patch("parcel_viewer.routers.parcels.pool")
        self.mock_pool = pool.start()
        self.addCleanup(pool.stop)

    @parameterized.expand(
        [
            ("search_too_long", "GET", "/search?q=" + "a" * 101, None, 422),
            ("search_too_short", "GET", "/search?q=a", None, 422),
            ("search_limit_zero", "GET", "/search?q=ab&limit=0", None, 422),
            ("search_limit_too_big", "GET", "/search?q=ab&limit=51", None, 422),
            ("bbox_not_numbers", "GET", "/parcels?bbox=a,b,c,d", None, 400),
            ("bbox_nan", "GET", "/parcels?bbox=nan,0,1,1", None, 400),
            ("bbox_three_values", "GET", "/parcels?bbox=1,2,3", None, 400),
            ("parcels_limit_zero", "GET", "/parcels?bbox=0,0,1,1&limit=0", None, 422),
            ("parcel_id_not_int", "GET", "/parcel/abc", None, 422),
            ("history_limit_too_big", "GET", "/parcel/1/history?limit=201", None, 422),
            ("nearest_road_no_coords", "GET", "/nearest-road", None, 422),
            ("nearest_road_not_numbers", "GET", "/nearest-road?lng=x&lat=y", None, 422),
            ("streetview_id_not_int", "GET", "/streetview-target?id=x", None, 422),
            ("cohort_buffer_off_the_globe", "POST", "/cohort",
             {"selector": {"type": "buffer", "lng": 500, "lat": 42, "distance_ft": 300}}, 400),
            ("cohort_unknown_selector", "POST", "/cohort", {"selector": {"type": "nope"}}, 400),
            ("cohort_limit_not_int", "POST", "/cohort", {"selector": {}, "limit": "x"}, 422),
        ]
    )  # fmt: skip
    def test_rejected_before_the_database(self, _name, method, path, body, status) -> None:
        response = self.client.request(method, path, json=body)

        self.assertEqual(response.status_code, status, response.text)
        self.mock_pool.connection.assert_not_called()


class ErrorLeakTests(TestCase):
    """An unexpected failure is a plain 500: no exception text, paths or SQL to the caller."""

    def test_unhandled_error_does_not_reach_the_response(self) -> None:
        pool = MagicMock()
        pool.connection.return_value.__enter__.return_value.execute.side_effect = RuntimeError(
            "secret-internals at /srv/app/db.py SELECT owner_name"
        )
        client = TestClient(main.app, raise_server_exceptions=False)

        with patch("parcel_viewer.routers.parcels.pool", pool):
            response = client.get("/search?q=smith")

        self.assertEqual(response.status_code, 500)
        self.assertNotIn("secret-internals", response.text)
        self.assertNotIn("owner_name", response.text)


class ReportErrorTests(TestCase):
    """/report-error emails the county inbox, so it's validated and rate-limited (DIC-1852)."""

    REPORT = {"pin": "80-01-001-001-00", "details": "The owner name is wrong."}

    def setUp(self) -> None:
        limiter.reset()
        self.addCleanup(limiter.reset)
        self.errors = create_autospec(ErrorLoggingClient, instance=True)
        main.app.dependency_overrides[get_error_logging_client] = lambda: self.errors
        self.addCleanup(main.app.dependency_overrides.clear)
        self.client = TestClient(main.app)

    @patch("parcel_viewer.routers.feedback.config.SMTP_HOST", None)
    def test_without_smtp_it_says_email_is_not_configured(self) -> None:
        response = self.client.post("/report-error", json=self.REPORT)

        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json(), {"ok": False, "error": "email_not_configured"})

    @patch("parcel_viewer.routers.feedback.config.SMTP_HOST", "smtp.example")
    @patch("parcel_viewer.routers.feedback._send_email", autospec=True)
    def test_a_valid_report_is_sent(self, mock_send) -> None:
        response = self.client.post("/report-error", json=self.REPORT)

        self.assertEqual(response.json(), {"ok": True})
        mock_send.assert_called_once()

    @patch("parcel_viewer.routers.feedback.config.SMTP_HOST", "smtp.example")
    @patch(
        "parcel_viewer.routers.feedback._send_email",
        autospec=True,
        side_effect=OSError("535 auth failed for gis@smtp.internal"),
    )
    def test_a_send_failure_hides_smtp_details_and_is_reported(self, _mock_send) -> None:
        with self.assertLogs("parcel_viewer.routers.feedback", level="ERROR"):
            response = self.client.post("/report-error", json=self.REPORT)

        self.assertEqual(response.status_code, 502)
        self.assertEqual(response.json(), {"ok": False, "error": "send_failed"})
        self.assertNotIn("smtp.internal", response.text)
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
    @patch("parcel_viewer.routers.feedback._send_email", autospec=True)
    def test_invalid_reports_are_rejected_unsent(self, _name, body, mock_send) -> None:
        response = self.client.post("/report-error", json=body)

        self.assertEqual(response.status_code, 422)
        mock_send.assert_not_called()

    @patch("parcel_viewer.routers.feedback.config.SMTP_HOST", "smtp.example")
    @patch("parcel_viewer.routers.feedback._send_email", autospec=True)
    def test_one_client_is_limited_to_five_reports_an_hour(self, mock_send) -> None:
        codes = [self.client.post("/report-error", json=self.REPORT).status_code for _ in range(6)]

        self.assertEqual(codes, [200] * 5 + [429])
        self.assertEqual(mock_send.call_count, 5)


class RouteStyleTests(TestCase):
    """Routes that touch the database, SMTP or the network must be plain `def` (FastAPI runs
    them in a thread pool); an `async def` doing blocking work stalls every request. Only
    routes known to do no I/O may be async; a new one fails here until it's reviewed."""

    ALLOWED_ASYNC = {"/style.json"}

    def test_no_unreviewed_async_routes(self) -> None:
        async_routes = {
            r.path
            for r in main.app.routes
            if isinstance(r, APIRoute) and inspect.iscoroutinefunction(r.endpoint)
        }

        self.assertEqual(async_routes, self.ALLOWED_ASYNC)
