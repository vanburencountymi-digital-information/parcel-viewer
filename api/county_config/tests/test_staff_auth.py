"""The admin routes for signed-in staff: county access, the store, the author (ADR 0013, DIC-2151)."""

from collections.abc import Iterable
from unittest.mock import MagicMock, patch

from django.contrib.auth import get_user_model
from django.test import TestCase, override_settings
from knox.models import AuthToken
from parameterized import parameterized
from rest_framework.test import APIClient

from accounts.models import CountyAccess
from county_config import store, views
from county_config.auth import STAFF_ONLY
from county_config.store import ConfigStore, PublishConflict
from county_config.tests.test_views import ADMIN_ROUTES, WRITER_ROUTES, _call


def _token_for(
    username: str,
    *,
    is_staff: bool = True,
    is_superuser: bool = False,
    counties: Iterable[str] = (),
) -> dict[str, str]:
    user = get_user_model().objects.create_user(
        username, password="x" * 20, is_staff=is_staff, is_superuser=is_superuser
    )
    for county in counties:
        CountyAccess.objects.create(user=user, county=county)
    _instance, token = AuthToken.objects.create(user)
    return {"HTTP_AUTHORIZATION": f"Token {token}"}


@override_settings(CONFIG_STORE_CONFIGURED=False)
class StaffGateTests(TestCase):
    """With no config store configured, getting past the gate shows up as a 503."""

    def setUp(self) -> None:
        self.client = APIClient()
        store.backoff.reset()

    @parameterized.expand(WRITER_ROUTES)
    def test_a_superuser_passes_for_any_county(self, _name, method, path, body) -> None:
        response = _call(self.client, method, path, body, **_token_for("root", is_superuser=True))

        self.assertEqual(response.status_code, 503)
        self.assertIn("not configured", response.json()["detail"])

    @parameterized.expand(WRITER_ROUTES)
    def test_staff_pass_for_a_county_granted_to_them(self, _name, method, path, body) -> None:
        response = _call(self.client, method, path, body, **_token_for("ed", counties=["vanburen"]))

        self.assertEqual(response.status_code, 503)

    @parameterized.expand(ADMIN_ROUTES)
    def test_staff_without_that_county_are_a_403(self, _name, method, path, body) -> None:
        for username, counties in (("nobody", []), ("elsewhere", ["kalamazoo"])):
            auth = _token_for(username, counties=counties)

            response = _call(self.client, method, path, body, **auth)

            self.assertEqual(response.status_code, 403, username)
            self.assertEqual(response.json(), {"detail": "No access to county 'vanburen'."})

    @parameterized.expand(ADMIN_ROUTES)
    def test_a_non_staff_token_is_a_403(self, _name, method, path, body) -> None:
        auth = _token_for("viewer", is_staff=False, counties=["vanburen"])

        response = _call(self.client, method, path, body, **auth)

        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.json(), {"detail": STAFF_ONLY})

    @parameterized.expand(ADMIN_ROUTES)
    def test_a_bad_token_is_a_401(self, _name, method, path, body) -> None:
        response = _call(self.client, method, path, body, HTTP_AUTHORIZATION="Token not-a-token")

        self.assertEqual(response.status_code, 401)

    @override_settings(CONFIG_STORE_CONFIGURED=True)
    def test_during_an_outage_writes_fail_fast(self) -> None:
        with self.assertLogs("county_config.store", level="WARNING"):
            store.backoff.mark_down("test")
        self.addCleanup(store.backoff.reset)

        response = self.client.get(
            "/config/vanburen/draft", **_token_for("root", is_superuser=True)
        )

        self.assertEqual(response.status_code, 503)
        self.assertIn("try again", response.json()["detail"])


@override_settings(CONFIG_STORE_CONFIGURED=True)
class WriterRouteTests(TestCase):
    """The store is a mock: these pin what the routes ask of it and how they answer."""

    def setUp(self) -> None:
        self.client = APIClient()
        store.backoff.reset()
        self.store = MagicMock(spec=ConfigStore)
        self.store.publish.return_value = 3
        self.store.rollback.return_value = 4
        patcher = patch("county_config.auth.store.ConfigStore", return_value=self.store)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.auth = _token_for("jhappel", counties=["vanburen"])

    def test_simultaneous_publish_is_a_409(self) -> None:
        self.store.publish.side_effect = PublishConflict("reload and try again")

        response = self.client.post("/config/vanburen/publish", {}, format="json", **self.auth)

        self.assertEqual(response.status_code, 409)
        self.assertIn("reload", response.json()["detail"])

    def test_rollback_to_a_missing_version_is_a_404(self) -> None:
        self.store.rollback.side_effect = ValueError("version 9 not found for county 'vanburen'")

        response = self.client.post(
            "/config/vanburen/rollback", {"version": 9}, format="json", **self.auth
        )

        self.assertEqual(response.status_code, 404)

    def test_a_draft_save_seeds_from_the_baked_manifest_and_records_the_user(self) -> None:
        response = self.client.put(
            "/config/vanburen/draft",
            {"payload": {"name": "x"}, "author": "someone-else"},
            format="json",
            **self.auth,
        )

        self.assertEqual(response.json(), {"ok": True})
        self.store.seed_if_empty.assert_called_once()
        self.store.save_draft.assert_called_once_with("vanburen", {"name": "x"}, "jhappel")

    def test_publish_and_rollback_authors_are_the_signed_in_user(self) -> None:
        self.client.post("/config/vanburen/publish", {"note": "n"}, format="json", **self.auth)
        self.client.post("/config/vanburen/rollback", {"version": 1}, format="json", **self.auth)

        self.store.publish.assert_called_once_with("vanburen", "jhappel", "n")
        self.store.rollback.assert_called_once_with("vanburen", 1, "jhappel")

    def test_invalid_body_with_a_valid_sign_in_is_a_422(self) -> None:
        response = self.client.post(
            "/config/vanburen/rollback", {"version": "x"}, format="json", **self.auth
        )

        self.assertEqual(response.status_code, 422)
        self.assertEqual(response.json()["detail"][0]["loc"], ["body", "version"])


class DiscoverLayersRouteTests(TestCase):
    def setUp(self) -> None:
        views._discovery_cache.clear()
        self.addCleanup(views._discovery_cache.clear)
        self.client = APIClient()
        self.auth = _token_for("ed", counties=["vanburen"])

    @patch("county_config.views.discover_layers", autospec=True, return_value=[{"id": "roads"}])
    def test_cached(self, mock_discover) -> None:
        for _ in range(2):
            response = self.client.get("/admin/discover/layers", **self.auth)
            self.assertEqual(response.json(), {"layers": [{"id": "roads"}]})

        mock_discover.assert_called_once()

    @patch("county_config.views.discover_layers", autospec=True, side_effect=RuntimeError("boom"))
    def test_a_failure_is_a_500_with_no_layers_and_no_internals(self, _mock_discover) -> None:
        with self.assertLogs("county_config.views", level="ERROR"):
            response = self.client.get("/admin/discover/layers", **self.auth)

        self.assertEqual(response.status_code, 500)
        self.assertEqual(response.json(), {"error": "layer discovery failed", "layers": []})

    @patch("county_config.views.discover_layers", autospec=True, return_value=[])
    def test_another_county_is_a_403_without_scanning(self, mock_discover) -> None:
        response = self.client.get("/admin/discover/layers", {"county": "kalamazoo"}, **self.auth)

        self.assertEqual(response.status_code, 403)
        mock_discover.assert_not_called()
