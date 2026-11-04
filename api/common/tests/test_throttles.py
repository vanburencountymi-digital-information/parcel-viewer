"""The client address every limit, the meter and the log key on (ADR 0018, DIC-2554)."""

from unittest.mock import patch

from access import meter
from django.core.cache import cache
from django.test import RequestFactory, SimpleTestCase, TestCase, override_settings
from parameterized import parameterized
from rest_framework.test import APIClient
from rest_framework.throttling import ScopedRateThrottle

from common.throttles import client_ip

PEER = "10.0.0.2"


def request(*, real_ip: str | None = None, forwarded: str | None = None):
    headers = {}
    if real_ip is not None:
        headers["HTTP_X_REAL_IP"] = real_ip
    if forwarded is not None:
        headers["HTTP_X_FORWARDED_FOR"] = forwarded
    return RequestFactory().get("/parcels", REMOTE_ADDR=PEER, **headers)


class ClientIpOnTheVmTests(SimpleTestCase):
    """No hops: our nginx is the only way in, and it sets X-Real-IP."""

    @override_settings(TRUSTED_PROXY_HOPS=0)
    def test_nginx_real_ip_wins(self) -> None:
        self.assertEqual(client_ip(request(real_ip="203.0.113.9")), "203.0.113.9")

    @override_settings(TRUSTED_PROXY_HOPS=0)
    def test_a_client_sent_forwarded_for_is_ignored(self) -> None:
        self.assertEqual(client_ip(request(forwarded="198.51.100.1")), PEER)


class ClientIpOnCloudRunTests(SimpleTestCase):
    """N hops: the address N places from the right of X-Forwarded-For."""

    @parameterized.expand(
        [
            ("cloud_run_alone", 1, "198.51.100.1, 203.0.113.5", "203.0.113.5"),
            ("load_balancer", 2, "198.51.100.1, 203.0.113.5, 192.0.2.9", "203.0.113.5"),
            ("load_balancer_no_client_header", 2, "203.0.113.5, 192.0.2.9", "203.0.113.5"),
            ("short_chain_gives_leftmost", 2, "203.0.113.5", "203.0.113.5"),
            ("spaces_and_empties", 1, " 198.51.100.1 ,, 203.0.113.5 ", "203.0.113.5"),
        ]
    )
    def test_the_hop_count_picks_the_client(self, _name, hops, forwarded, expected) -> None:
        with override_settings(TRUSTED_PROXY_HOPS=hops):
            self.assertEqual(client_ip(request(forwarded=forwarded)), expected)

    @override_settings(TRUSTED_PROXY_HOPS=2)
    def test_x_real_ip_is_not_trusted(self) -> None:
        # Google's front end passes a client's X-Real-IP through unchanged.
        forged = request(real_ip="1.2.3.4", forwarded="203.0.113.5, 192.0.2.9")

        self.assertEqual(client_ip(forged), "203.0.113.5")

    @override_settings(TRUSTED_PROXY_HOPS=1)
    def test_no_header_falls_back_to_the_socket_peer(self) -> None:
        self.assertEqual(client_ip(request()), PEER)

    @override_settings(TRUSTED_PROXY_HOPS=2)
    def test_the_meter_charges_the_same_client(self) -> None:
        a = meter.client_for(request(forwarded="198.51.100.1, 203.0.113.5, 192.0.2.9"))
        b = meter.client_for(request(forwarded="198.51.100.2, 203.0.113.5, 192.0.2.9"))

        self.assertEqual((a.label, a.key), ("203.0.113.5", b.key))

    @override_settings(TRUSTED_PROXY_HOPS=2)
    def test_the_access_log_shows_the_client(self) -> None:
        with self.assertLogs("access", level="DEBUG") as logs:
            APIClient().get("/health/live", HTTP_X_FORWARDED_FOR="203.0.113.5, 192.0.2.9")

        self.assertEqual(logs.records[-1].client_ip, "203.0.113.5")


class DrfThrottlesUseTheClientTests(TestCase):
    """DRF's own throttles key on the whole X-Forwarded-For by default; ours don't."""

    def setUp(self) -> None:
        cache.clear()
        self.addCleanup(cache.clear)

    def _login_codes(self, forwarded_values: list[str], **extra) -> list[int]:
        client = APIClient()
        body = {"username": "x", "password": "y"}
        with self.assertLogs("accounts.views", level="WARNING"):
            return [
                client.post(
                    "/auth/login", body, format="json", HTTP_X_FORWARDED_FOR=f, **extra
                ).status_code
                for f in forwarded_values
            ]

    @patch.object(ScopedRateThrottle, "THROTTLE_RATES", {"login": "2/min"})
    @override_settings(TRUSTED_PROXY_HOPS=0)
    def test_a_new_forwarded_for_per_guess_does_not_reset_the_limit(self) -> None:
        codes = self._login_codes(["1.1.1.1", "2.2.2.2", "3.3.3.3"], HTTP_X_REAL_IP="203.0.113.9")

        self.assertEqual(codes, [401, 401, 429])

    @patch.object(ScopedRateThrottle, "THROTTLE_RATES", {"login": "2/min"})
    @override_settings(TRUSTED_PROXY_HOPS=2)
    def test_behind_a_load_balancer_clients_are_counted_apart(self) -> None:
        codes = self._login_codes(
            ["203.0.113.5, 192.0.2.9", "203.0.113.5, 192.0.2.9", "203.0.113.6, 192.0.2.9"]
        )

        self.assertEqual(codes, [401, 401, 401])
