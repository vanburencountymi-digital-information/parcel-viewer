"""Staff sign-in: who can get a token, what it's good for, and how it ends (ADR 0013)."""

from datetime import timedelta
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.test import TestCase, override_settings
from django.utils import timezone
from knox.models import AuthToken
from parameterized import parameterized
from rest_framework.test import APIClient
from rest_framework.throttling import ScopedRateThrottle

from accounts.views import LOGIN_FAILED

PASSWORD = "a-long-test-password"


def make_user(username: str = "staffer", *, is_staff: bool = True, is_active: bool = True):
    return get_user_model().objects.create_user(
        username, password=PASSWORD, is_staff=is_staff, is_active=is_active
    )


class LoginTests(TestCase):
    def setUp(self) -> None:
        self.client = APIClient()

    def _login(self, username: str = "staffer", password: str = PASSWORD):
        return self.client.post(
            "/auth/login", {"username": username, "password": password}, format="json"
        )

    def test_a_staff_user_gets_a_token_that_expires(self) -> None:
        make_user()

        response = self._login()

        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["user"], {"username": "staffer"})
        self.assertEqual(len(body["token"]), 64)
        token = AuthToken.objects.get()
        self.assertIsNotNone(token.expiry)
        self.assertGreater(token.expiry, timezone.now() + timedelta(hours=9))
        # Only a hash is stored, never the token itself.
        self.assertNotIn(body["token"], token.digest)

    def test_signing_in_records_the_last_login(self) -> None:
        user = make_user()

        self._login()

        user.refresh_from_db()
        self.assertIsNotNone(user.last_login)

    @parameterized.expand(
        [
            ("wrong_password", {}, "staffer", "not-the-password"),
            ("unknown_user", {}, "nobody", PASSWORD),
            ("not_staff", {"is_staff": False}, "staffer", PASSWORD),
            ("inactive", {"is_active": False}, "staffer", PASSWORD),
        ]
    )
    def test_every_refusal_looks_the_same(self, _name, user_kwargs, username, password) -> None:
        make_user(**user_kwargs)

        with self.assertLogs("accounts.views", level="WARNING"):
            response = self._login(username, password)

        self.assertEqual(response.status_code, 401)
        self.assertEqual(response.json(), {"detail": LOGIN_FAILED})
        self.assertFalse(AuthToken.objects.exists())

    def test_a_missing_field_is_a_422(self) -> None:
        response = self.client.post("/auth/login", {"username": "staffer"}, format="json")

        self.assertEqual(response.status_code, 422)
        self.assertEqual(response.json()["detail"][0]["loc"], ["body", "password"])

    @override_settings(TOKENS_PER_USER=2)
    def test_signing_in_past_the_limit_drops_the_oldest_token(self) -> None:
        make_user()
        first = self._login().json()["token"]
        self._login()
        self._login()

        self.assertEqual(AuthToken.objects.count(), 2)
        response = self.client.get("/auth/me", HTTP_AUTHORIZATION=f"Token {first}")
        self.assertEqual(response.status_code, 401)

    def test_expired_tokens_are_cleared_on_sign_in(self) -> None:
        user = make_user()
        AuthToken.objects.create(user, expiry=timedelta(seconds=-1))

        self._login()

        self.assertEqual(AuthToken.objects.count(), 1)


class LoginThrottleTests(TestCase):
    def setUp(self) -> None:
        cache.clear()
        self.addCleanup(cache.clear)

    # DRF reads the rates once, when the throttle class is defined, so patch them there.
    @patch.object(ScopedRateThrottle, "THROTTLE_RATES", {"login": "2/min"})
    def test_password_guessing_is_rate_limited(self) -> None:
        client = APIClient()
        body = {"username": "x", "password": "y"}

        with self.assertLogs("accounts.views", level="WARNING"):
            codes = [client.post("/auth/login", body, format="json").status_code for _ in range(3)]

        self.assertEqual(codes, [401, 401, 429])


class SignedInTests(TestCase):
    def setUp(self) -> None:
        self.client = APIClient()
        self.user = make_user()
        self.instance, self.token = AuthToken.objects.create(self.user)
        self.auth = {"HTTP_AUTHORIZATION": f"Token {self.token}"}

    def test_me_names_the_user(self) -> None:
        response = self.client.get("/auth/me", **self.auth)

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["user"], {"username": "staffer", "is_staff": True})

    @parameterized.expand(
        [
            ("none", {}),
            ("garbage", {"HTTP_AUTHORIZATION": "Token not-a-token"}),
            ("no_credentials", {"HTTP_AUTHORIZATION": "Token"}),
        ]
    )
    def test_me_without_a_valid_token_is_a_401(self, _name, headers) -> None:
        response = self.client.get("/auth/me", **headers)

        self.assertEqual(response.status_code, 401)

    def test_an_expired_token_is_refused_and_deleted(self) -> None:
        self.instance.expiry = timezone.now() - timedelta(seconds=1)
        self.instance.save()

        response = self.client.get("/auth/me", **self.auth)

        self.assertEqual(response.status_code, 401)
        self.assertFalse(AuthToken.objects.exists())

    def test_deactivating_a_user_ends_their_tokens(self) -> None:
        self.user.is_active = False
        self.user.save()

        response = self.client.get("/auth/me", **self.auth)

        self.assertEqual(response.status_code, 401)

    def test_logout_revokes_only_this_token(self) -> None:
        _other, other_token = AuthToken.objects.create(self.user)

        response = self.client.post("/auth/logout", **self.auth)

        self.assertEqual(response.json(), {"ok": True})
        self.assertEqual(self.client.get("/auth/me", **self.auth).status_code, 401)
        other = self.client.get("/auth/me", HTTP_AUTHORIZATION=f"Token {other_token}")
        self.assertEqual(other.status_code, 200)

    def test_the_retired_shared_admin_key_is_not_a_sign_in(self) -> None:
        response = self.client.get("/auth/me", HTTP_X_ADMIN_TOKEN="the-old-shared-key")

        self.assertEqual(response.status_code, 401)
