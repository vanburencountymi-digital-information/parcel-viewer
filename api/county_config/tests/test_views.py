"""The config routes' contract, as pinned for FastAPI by backend/app/tests (DIC-1872, DIC-1874)."""

from unittest.mock import patch

from django.test import SimpleTestCase
from parameterized import parameterized
from rest_framework.test import APIClient

from county_config.auth import SIGN_IN_REQUIRED

# Every admin route, with a body that's valid, so only the gate decides the outcome.
# Signed-in cases (tokens, county access, the store) are in test_staff_auth.py.
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


class AdminGateTests(SimpleTestCase):
    """Without a staff sign-in the admin routes refuse, before any database work."""

    def setUp(self) -> None:
        self.client = APIClient()

    @parameterized.expand(ADMIN_ROUTES)
    @patch("county_config.views.discover_layers", autospec=True, return_value=[])
    @patch("county_config.auth.store.ConfigStore", autospec=True)
    def test_without_a_sign_in_is_a_401_with_no_database_work(
        self, _name, method, path, body, mock_store, mock_discover
    ) -> None:
        # The retired shared key (DIC-2151) and a non-Knox scheme are no sign-in either.
        for headers in (
            {},
            {"HTTP_X_ADMIN_TOKEN": "the-old-shared-key"},
            {"HTTP_AUTHORIZATION": "Basic dXNlcjpwYXNz"},
        ):
            response = _call(self.client, method, path, body, **headers)

            self.assertEqual(response.status_code, 401, headers)
            self.assertEqual(response.json(), {"detail": SIGN_IN_REQUIRED})
        mock_store.assert_not_called()
        mock_discover.assert_not_called()

    def test_auth_comes_before_body_validation(self) -> None:
        response = self.client.put(
            "/config/vanburen/draft", {"payload": "not a dict"}, format="json"
        )

        self.assertEqual(response.status_code, 401)


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
