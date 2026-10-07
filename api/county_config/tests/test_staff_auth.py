"""The admin routes with staff tokens, and with the shared key turned off (ADR 0013)."""

from unittest.mock import MagicMock, patch

from django.contrib.auth import get_user_model
from django.test import TestCase, override_settings
from knox.models import AuthToken
from parameterized import parameterized
from rest_framework.test import APIClient

from county_config import store
from county_config.auth import ADMIN_REQUIRED, STAFF_ONLY
from county_config.store import ConfigStore
from county_config.tests.test_views import ADMIN_ROUTES, WRITER_ROUTES, _call

SHARED_KEY = "test-admin-token"


def _token_for(username: str, *, is_staff: bool = True) -> dict[str, str]:
    user = get_user_model().objects.create_user(username, password="x" * 20, is_staff=is_staff)
    _instance, token = AuthToken.objects.create(user)
    return {"HTTP_AUTHORIZATION": f"Token {token}"}


@override_settings(ADMIN_TOKEN=SHARED_KEY, CONFIG_STORE_CONFIGURED=False)
class StaffTokenGateTests(TestCase):
    """With no config store configured, getting past the gate shows up as a 503."""

    def setUp(self) -> None:
        self.client = APIClient()
        store.backoff.reset()

    @parameterized.expand(WRITER_ROUTES)
    def test_a_staff_token_passes_the_gate(self, _name, method, path, body) -> None:
        response = _call(self.client, method, path, body, **_token_for("staffer"))

        self.assertEqual(response.status_code, 503)

    @parameterized.expand(ADMIN_ROUTES)
    def test_a_non_staff_token_is_a_403(self, _name, method, path, body) -> None:
        response = _call(self.client, method, path, body, **_token_for("viewer", is_staff=False))

        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.json(), {"detail": STAFF_ONLY})

    @parameterized.expand(ADMIN_ROUTES)
    def test_a_bad_token_is_a_401_even_with_the_shared_key(self, _name, method, path, body) -> None:
        headers = {"HTTP_AUTHORIZATION": "Token not-a-token", "HTTP_X_ADMIN_TOKEN": SHARED_KEY}

        response = _call(self.client, method, path, body, **headers)

        self.assertEqual(response.status_code, 401)

    @parameterized.expand(WRITER_ROUTES)
    @override_settings(ADMIN_SHARED_KEY_ACCEPTED=False)
    def test_with_the_shared_key_retired_only_tokens_work(self, _name, method, path, body) -> None:
        refused = _call(self.client, method, path, body, HTTP_X_ADMIN_TOKEN=SHARED_KEY)
        allowed = _call(self.client, method, path, body, **_token_for("staffer"))

        self.assertEqual(refused.status_code, 401)
        self.assertEqual(refused.json(), {"detail": ADMIN_REQUIRED})
        self.assertEqual(allowed.status_code, 503)

    @override_settings(ADMIN_SHARED_KEY_ACCEPTED=False)
    @patch("county_config.views.discover_layers", autospec=True, return_value=[])
    def test_discovery_with_the_shared_key_retired(self, mock_discover) -> None:
        refused = self.client.get("/admin/discover/layers?county=x1", HTTP_X_ADMIN_TOKEN=SHARED_KEY)
        allowed = self.client.get("/admin/discover/layers?county=x2", **_token_for("staffer"))

        self.assertEqual(refused.status_code, 401)
        self.assertEqual(allowed.status_code, 200)
        mock_discover.assert_called_once_with("x2")


@override_settings(ADMIN_TOKEN=SHARED_KEY, CONFIG_STORE_CONFIGURED=True)
class StaffAuthorTests(TestCase):
    """A token's user is the author; the body can't name someone else."""

    def setUp(self) -> None:
        self.client = APIClient()
        store.backoff.reset()
        self.store = MagicMock(spec=ConfigStore)
        self.store.publish.return_value = 3
        self.store.rollback.return_value = 4
        patcher = patch("county_config.auth.store.ConfigStore", return_value=self.store)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.auth = _token_for("jhappel")

    def test_draft_author_is_the_signed_in_user(self) -> None:
        self.client.put(
            "/config/vanburen/draft",
            {"payload": {"name": "x"}, "author": "someone-else"},
            format="json",
            **self.auth,
        )

        self.store.save_draft.assert_called_once_with("vanburen", {"name": "x"}, "jhappel")

    def test_publish_and_rollback_authors_are_the_signed_in_user(self) -> None:
        self.client.post("/config/vanburen/publish", {"note": "n"}, format="json", **self.auth)
        self.client.post("/config/vanburen/rollback", {"version": 1}, format="json", **self.auth)

        self.store.publish.assert_called_once_with("vanburen", "jhappel", "n")
        self.store.rollback.assert_called_once_with("vanburen", 1, "jhappel")

    def test_with_the_shared_key_the_body_still_names_the_author(self) -> None:
        self.client.post(
            "/config/vanburen/publish",
            {"author": "console"},
            format="json",
            HTTP_X_ADMIN_TOKEN=SHARED_KEY,
        )

        self.store.publish.assert_called_once_with("vanburen", "console", None)
