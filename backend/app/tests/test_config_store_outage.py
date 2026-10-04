"""Writer-DB outage handling for the config store (DIC-1872).

Before: every request built a new ConfigStore, waited out its connection timeout
(~10s on the public /config.js path), leaked its pool, and logged nothing.
"""

from unittest import TestCase
from unittest.mock import MagicMock, create_autospec, patch

from fastapi.testclient import TestClient

from app import main
from parcel_viewer.common.error_logging_client import ErrorLoggingClient, get_error_logging_client

TOKEN = {"X-Admin-Token": "test-token"}


class _OutageTestCase(TestCase):
    def setUp(self) -> None:
        main._store_singleton = None
        main._store_down_until = 0.0
        configured = patch("app.main.config_store.is_configured", return_value=True)
        configured.start()
        self.addCleanup(configured.stop)

    def tearDown(self) -> None:
        main._store_singleton = None
        main._store_down_until = 0.0


class GetStoreTests(_OutageTestCase):
    @patch("app.main.config_store.ConfigStore", autospec=True)
    def test_failed_init_closes_the_pool_logs_once_and_backs_off(self, mock_cls) -> None:
        mock_cls.return_value.init_schema.side_effect = OSError("connection refused")

        with (
            self.assertLogs("parcel_viewer.api", level="WARNING") as logs,
            self.assertRaises(main.ConfigStoreUnavailable),
        ):
            main._get_store()
        mock_cls.return_value.close.assert_called_once()  # no leaked pool
        self.assertEqual(len(logs.records), 1)

        # Inside the backoff window: fails fast, builds nothing, logs nothing.
        with self.assertRaises(main.ConfigStoreUnavailable):
            main._get_store()
        self.assertEqual(mock_cls.call_count, 1)

    @patch("app.main.time.monotonic")
    @patch("app.main.config_store.ConfigStore", autospec=True)
    def test_retries_after_the_backoff(self, mock_cls, mock_clock) -> None:
        mock_clock.return_value = 1000.0
        mock_cls.return_value.init_schema.side_effect = [OSError("down"), None]
        with (
            self.assertLogs("parcel_viewer.api", level="WARNING"),
            self.assertRaises(main.ConfigStoreUnavailable),
        ):
            main._get_store()

        mock_clock.return_value = 1000.0 + main.STORE_RETRY_S + 1
        store = main._get_store()

        self.assertIs(store, mock_cls.return_value)
        self.assertIs(main._get_store(), store)  # built once, then reused
        self.assertEqual(mock_cls.call_count, 2)


class PublicReadPathTests(_OutageTestCase):
    @patch("app.main._load_county_config", return_value={"name": "baked"})
    @patch("app.main.config_store.ConfigStore", autospec=True)
    def test_outage_serves_the_baked_manifest(self, mock_cls, _mock_baked) -> None:
        mock_cls.return_value.init_schema.side_effect = OSError("down")

        with self.assertLogs("parcel_viewer.api", level="WARNING"):
            first = main._published_config("vanburen")
        second = main._published_config("vanburen")  # within the backoff: no new attempt

        self.assertEqual(first, {"name": "baked"})
        self.assertEqual(second, {"name": "baked"})
        self.assertEqual(mock_cls.call_count, 1)

    @patch("app.main._load_county_config", return_value={"name": "baked"})
    def test_a_failing_read_starts_the_backoff(self, _mock_baked) -> None:
        store = MagicMock()
        store.get_published.side_effect = OSError("connection lost")
        main._store_singleton = store

        with self.assertLogs("parcel_viewer.api", level="WARNING") as logs:
            self.assertEqual(main._published_config("vanburen"), {"name": "baked"})

        self.assertIn("read failed", logs.output[-1])
        self.assertGreater(main._store_down_until, 0)


class WriterGuardTests(_OutageTestCase):
    def setUp(self) -> None:
        super().setUp()
        token = patch("app.main._ADMIN_TOKEN", "test-token")
        token.start()
        self.addCleanup(token.stop)
        self.errors = create_autospec(ErrorLoggingClient, instance=True)
        main.app.dependency_overrides[get_error_logging_client] = lambda: self.errors
        self.addCleanup(main.app.dependency_overrides.clear)
        self.client = TestClient(main.app)

    @patch("app.main._get_store", autospec=True)
    def test_auth_is_checked_before_the_database(self, mock_get_store) -> None:
        response = self.client.get("/config/vanburen/draft")  # no token

        self.assertEqual(response.status_code, 401)
        mock_get_store.assert_not_called()

    @patch("app.main._get_store", autospec=True, side_effect=main.ConfigStoreUnavailable("backoff"))
    def test_during_an_outage_writes_fail_fast_without_re_reporting(self, _mock_get_store) -> None:
        response = self.client.get("/config/vanburen/draft", headers=TOKEN)

        self.assertEqual(response.status_code, 503)
        self.assertIn("try again", response.json()["detail"])
        self.errors.report_exception.assert_not_called()


class PublishConflictRouteTests(WriterGuardTests):
    def test_simultaneous_publish_is_a_409(self) -> None:
        store = MagicMock()
        store.publish.side_effect = main.config_store.PublishConflict("reload and try again")
        with patch("app.main._get_store", return_value=store):
            response = self.client.post("/config/vanburen/publish", json={}, headers=TOKEN)

        self.assertEqual(response.status_code, 409)
        self.assertIn("reload", response.json()["detail"])
