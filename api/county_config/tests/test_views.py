"""The config routes' contract, as pinned for FastAPI by backend/app/tests (DIC-1872, DIC-1874)."""

from unittest.mock import MagicMock, patch

from django.test import SimpleTestCase, override_settings
from parameterized import parameterized
from rest_framework.test import APIClient

from county_config import store, views
from county_config.store import ConfigStore, PublishConflict

TOKEN = "test-admin-token"
AUTH = {"HTTP_X_ADMIN_TOKEN": TOKEN}

# Every admin route, with a body that's valid, so only the gate decides the outcome.
ADMIN_ROUTES = [
    ("get_draft", "get", "/config/vanburen/draft", None),
    ("put_draft", "put", "/config/vanburen/draft", {"payload": {}}),
    ("publish", "post", "/config/vanburen/publish", {}),
    ("versions", "get", "/config/vanburen/versions", None),
    ("rollback", "post", "/config/vanburen/rollback", {"version": 1}),
    ("discover", "get", "/admin/discover/layers", None),
]
WRITER_ROUTES = [r for r in ADMIN_ROUTES if r[0] != "discover"]


def _call(client: APIClient, method: str, path: str, body: object, **headers: str):
    return getattr(client, method)(path, body, format="json", **headers)


@override_settings(ADMIN_TOKEN=TOKEN, CONFIG_STORE_CONFIGURED=True)
class AdminGateTests(SimpleTestCase):
    """Admin routes need the key, checked before any database work."""

    def setUp(self) -> None:
        self.client = APIClient()
        store.backoff.reset()
        self.addCleanup(store.backoff.reset)

    @parameterized.expand(ADMIN_ROUTES)
    @patch("county_config.views.discover_layers", autospec=True, return_value=[])
    @patch("county_config.auth.store.ConfigStore", autospec=True)
    def test_no_or_wrong_key_is_a_401_with_no_database_work(
        self, _name, method, path, body, mock_store, mock_discover
    ) -> None:
        for headers in ({}, {"HTTP_X_ADMIN_TOKEN": "wrong"}, {"HTTP_X_ADMIN_TOKEN": ""}):
            response = _call(self.client, method, path, body, **headers)

            self.assertEqual(response.status_code, 401, headers)
            self.assertEqual(
                response.json(),
                {"detail": "Admin auth required (interim PV_ADMIN_TOKEN; real auth is DIC-463)."},
            )
        mock_store.assert_not_called()
        mock_discover.assert_not_called()

    @parameterized.expand(ADMIN_ROUTES)
    @override_settings(ADMIN_TOKEN="")
    def test_no_key_configured_on_the_server_refuses_everyone(
        self, _name, method, path, body
    ) -> None:
        response = _call(self.client, method, path, body, HTTP_X_ADMIN_TOKEN="")

        self.assertEqual(response.status_code, 401)

    @parameterized.expand(WRITER_ROUTES)
    @override_settings(CONFIG_STORE_CONFIGURED=False)
    def test_valid_key_without_a_config_store_is_a_503(self, _name, method, path, body) -> None:
        response = _call(self.client, method, path, body, **AUTH)

        self.assertEqual(response.status_code, 503)
        self.assertIn("not configured", response.json()["detail"])

    def test_auth_comes_before_body_validation(self) -> None:
        response = self.client.put(
            "/config/vanburen/draft", {"payload": "not a dict"}, format="json"
        )

        self.assertEqual(response.status_code, 401)

    def test_during_an_outage_writes_fail_fast(self) -> None:
        with self.assertLogs("county_config.store", level="WARNING"):
            store.backoff.mark_down("test")

        response = self.client.get("/config/vanburen/draft", **AUTH)

        self.assertEqual(response.status_code, 503)
        self.assertIn("try again", response.json()["detail"])


@override_settings(ADMIN_TOKEN=TOKEN, CONFIG_STORE_CONFIGURED=True)
class WriterRouteTests(SimpleTestCase):
    def setUp(self) -> None:
        self.client = APIClient()
        store.backoff.reset()
        self.store = MagicMock(spec=ConfigStore)
        patcher = patch("county_config.auth.store.ConfigStore", return_value=self.store)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_simultaneous_publish_is_a_409(self) -> None:
        self.store.publish.side_effect = PublishConflict("reload and try again")

        response = self.client.post("/config/vanburen/publish", {}, format="json", **AUTH)

        self.assertEqual(response.status_code, 409)
        self.assertIn("reload", response.json()["detail"])

    def test_rollback_to_a_missing_version_is_a_404(self) -> None:
        self.store.rollback.side_effect = ValueError("version 9 not found for county 'vanburen'")

        response = self.client.post(
            "/config/vanburen/rollback", {"version": 9}, format="json", **AUTH
        )

        self.assertEqual(response.status_code, 404)

    def test_a_draft_save_seeds_a_county_from_its_baked_manifest_first(self) -> None:
        response = self.client.put(
            "/config/vanburen/draft",
            {"payload": {"name": "x"}, "author": "jh"},
            format="json",
            **AUTH,
        )

        self.assertEqual(response.json(), {"ok": True})
        self.store.seed_if_empty.assert_called_once()
        self.store.save_draft.assert_called_once_with("vanburen", {"name": "x"}, "jh")

    def test_invalid_body_with_a_valid_key_is_a_422(self) -> None:
        response = self.client.post(
            "/config/vanburen/rollback", {"version": "x"}, format="json", **AUTH
        )

        self.assertEqual(response.status_code, 422)
        self.assertEqual(response.json()["detail"][0]["loc"], ["body", "version"])


class PublicConfigRouteTests(SimpleTestCase):
    def setUp(self) -> None:
        self.client = APIClient()

    def test_config_js_sets_window_county_and_is_not_cached(self) -> None:
        response = self.client.get("/config.js")

        self.assertEqual(response["Content-Type"], "application/javascript")
        self.assertEqual(response["Cache-Control"], "no-cache")
        self.assertTrue(response.content.startswith(b"window.COUNTY = {"))

    def test_config_js_404_does_not_echo_the_county(self) -> None:
        response = self.client.get("/config.js", {"county": "x*/alert(1)/*"})

        self.assertEqual(response.status_code, 404)
        self.assertNotIn(b"alert", response.content)

    def test_unknown_county_json_names_it(self) -> None:
        response = self.client.get("/config", {"county": "nowhere"})

        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.json(), {"error": "Unknown county: nowhere"})

    def test_style_has_the_tile_placeholder(self) -> None:
        style = self.client.get("/style.json").json()

        self.assertEqual(
            style["sources"]["parcels"]["tiles"], ["{MARTIN_URL}/parcel_tiles/{z}/{x}/{y}"]
        )


@override_settings(ADMIN_TOKEN=TOKEN)
class DiscoverLayersRouteTests(SimpleTestCase):
    def setUp(self) -> None:
        views._discovery_cache.clear()
        self.addCleanup(views._discovery_cache.clear)
        self.client = APIClient()

    @patch("county_config.views.discover_layers", autospec=True, return_value=[{"id": "roads"}])
    def test_cached(self, mock_discover) -> None:
        for _ in range(2):
            response = self.client.get("/admin/discover/layers", **AUTH)
            self.assertEqual(response.json(), {"layers": [{"id": "roads"}]})

        mock_discover.assert_called_once()

    @patch("county_config.views.discover_layers", autospec=True, side_effect=RuntimeError("boom"))
    def test_a_failure_is_a_500_with_no_layers_and_no_internals(self, _mock_discover) -> None:
        with self.assertLogs("county_config.views", level="ERROR"):
            response = self.client.get("/admin/discover/layers", **AUTH)

        self.assertEqual(response.status_code, 500)
        self.assertEqual(response.json(), {"error": "layer discovery failed", "layers": []})
