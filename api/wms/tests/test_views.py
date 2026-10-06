"""The WMS proxy's hardening (CodeQL py/full-ssrf, DIC-1880; DIC-1872), ported from backend/app/tests/test_main.py."""

import urllib.error
from email.message import Message
from unittest.mock import MagicMock, patch

from django.core.cache import cache
from django.test import SimpleTestCase, override_settings
from parameterized import parameterized
from rest_framework.test import APIClient

from wms import proxy

FEMA = "https://hazards.fema.gov/arcgis/x"


def _upstream(body: bytes, content_type: str) -> MagicMock:
    response = MagicMock()
    response.__enter__.return_value = response
    response.read.side_effect = lambda n=-1: body[:n] if n >= 0 else body
    response.headers = {"Content-Type": content_type}
    return response


class WmsProxyTests(SimpleTestCase):
    def setUp(self) -> None:
        cache.clear()
        self.addCleanup(cache.clear)
        self.client = APIClient()

    @parameterized.expand(
        [
            ("plain_http", "http://hazards.fema.gov/arcgis/x"),
            ("other_host", "https://evil.example/x"),
            ("lookalike_host", "https://hazards.fema.gov.evil.example/x"),
            ("userinfo", "https://user:pw@hazards.fema.gov/x"),
            ("odd_port", "https://hazards.fema.gov:8443/x"),
            ("internal", "https://169.254.169.254/latest/meta-data"),
            # FastAPI crashed with a 500 on an unparsable port; the port refuses it instead.
            ("unparsable_port", "https://hazards.fema.gov:abc/x"),
        ]
    )
    def test_rejects_urls_off_the_allowlist(self, _name: str, url: str) -> None:
        with patch.object(proxy._opener, "open") as mock_open:
            response = self.client.get("/wms-proxy", {"url": url})

        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.json(), {"error": "URL not allowed"})
        mock_open.assert_not_called()

    @patch.object(proxy._opener, "open")
    def test_passes_map_data_through_from_a_rebuilt_url(self, mock_open) -> None:
        mock_open.return_value = _upstream(b'{"features": []}', "application/json; charset=utf-8")

        response = self.client.get("/wms-proxy", {"url": FEMA + "?f=json#frag"})

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"features": []})
        self.assertEqual(response["X-Content-Type-Options"], "nosniff")
        self.assertEqual(mock_open.call_args.args[0].full_url, FEMA + "?f=json")

    @patch.object(proxy._opener, "open")
    def test_refuses_html_from_upstream(self, mock_open) -> None:
        mock_open.return_value = _upstream(b"<script>alert(1)</script>", "text/html")

        with self.assertLogs("parcel_viewer.api", level="WARNING"):
            response = self.client.get("/wms-proxy", {"url": FEMA})

        self.assertEqual(response.status_code, 502)
        self.assertNotIn(b"script", response.content)

    @override_settings(WMS_PROXY_MAX_BYTES=10)
    @patch.object(proxy._opener, "open")
    def test_caps_the_response_size(self, mock_open) -> None:
        mock_open.return_value = _upstream(b"x" * 11, "text/plain")

        with self.assertLogs("parcel_viewer.api", level="WARNING"):
            response = self.client.get("/wms-proxy", {"url": FEMA})

        self.assertEqual(response.status_code, 502)
        self.assertEqual(response.json(), {"error": "upstream response too large"})

    @patch.object(proxy._opener, "open")
    def test_does_not_follow_or_reflect_redirects(self, mock_open) -> None:
        headers = Message()
        headers["Location"] = "http://169.254.169.254/"
        mock_open.side_effect = urllib.error.HTTPError(FEMA, 302, "Found", headers, None)

        with self.assertLogs("parcel_viewer.api", level="WARNING"):
            response = self.client.get("/wms-proxy", {"url": FEMA})

        self.assertEqual(response.status_code, 502)
        self.assertEqual(response.json(), {"error": "upstream map service returned 302"})

    def test_the_opener_refuses_redirects(self) -> None:
        self.assertIsNone(proxy._NoRedirects().redirect_request())

    @override_settings(WMS_PROXY_RATE_LIMIT="2/minute")
    def test_rate_limited_per_client_with_fastapis_429(self) -> None:
        codes = [
            self.client.get("/wms-proxy", {"url": "https://evil.example/"}).status_code
            for _ in range(3)
        ]

        self.assertEqual(codes, [403, 403, 429])
        response = self.client.get("/wms-proxy", {"url": "https://evil.example/"})
        self.assertEqual(response.json(), {"error": "Rate limit exceeded: 2 per 1 minute"})

    @override_settings(WMS_PROXY_RATE_LIMIT="1/minute")
    def test_a_missing_url_doesnt_use_up_the_limit(self) -> None:
        self.assertEqual(self.client.get("/wms-proxy").status_code, 422)
        self.assertEqual(
            self.client.get("/wms-proxy", {"url": "https://evil.example/"}).status_code, 403
        )
