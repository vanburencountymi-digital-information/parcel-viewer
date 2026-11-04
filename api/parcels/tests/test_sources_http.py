"""The parcel-data-api client's transport, against a fake server on a thread (DIC-2802).

Paths and bodies are the TODO(DIC-2779) placeholders; what's pinned here is the part that
doesn't depend on the contract: auth, timeouts, the one retry, and the error mapping.
"""

from __future__ import annotations

import json
import socket
import threading
import time
from collections.abc import Callable
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from unittest.mock import patch

from django.core.exceptions import ImproperlyConfigured
from django.test import SimpleTestCase

from parcels.sources.errors import ParcelSourceBusy, ParcelSourceRejected, ParcelSourceUnavailable
from parcels.sources.http import PATHS, ApiParcelSource, Timeouts

TOKEN = "test-service-token-0123456789"

# (status, body, headers, delay seconds); a body that isn't bytes is sent as JSON.
Reply = tuple[int, Any, dict[str, str], float]


class FakeParcelDataApi:
    """A tiny HTTP server: answers each request with the next queued reply, records requests."""

    def __init__(self) -> None:
        self.replies: list[Reply] = []
        self.requests: list[dict[str, Any]] = []
        fake = self

        class Handler(BaseHTTPRequestHandler):
            def _answer(self) -> None:
                length = int(self.headers.get("Content-Length") or 0)
                fake.requests.append(
                    {
                        "method": self.command,
                        "path": self.path,
                        "headers": dict(self.headers),
                        "body": self.rfile.read(length) if length else b"",
                    }
                )
                status, body, headers, delay = (
                    fake.replies.pop(0) if fake.replies else (200, [], {}, 0.0)
                )
                if delay:
                    time.sleep(delay)
                raw = body if isinstance(body, bytes) else json.dumps(body).encode()
                try:
                    self.send_response(status)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(raw)))
                    for name, value in headers.items():
                        self.send_header(name, value)
                    self.end_headers()
                    self.wfile.write(raw)
                except (BrokenPipeError, ConnectionResetError):
                    pass  # the client gave up (a timeout test)

            do_GET = _answer
            do_POST = _answer

            def log_message(self, *args: Any) -> None:
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.base_url = f"http://127.0.0.1:{self.server.server_address[1]}/v-test"
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def reply(self, status: int, body: Any = None, *, headers: dict[str, str] | None = None, delay: float = 0.0) -> None:  # fmt: skip
        self.replies.append((status, [] if body is None else body, headers or {}, delay))

    def stop(self) -> None:
        self.server.shutdown()
        self.server.server_close()


class ApiParcelSourceTests(SimpleTestCase):
    def setUp(self) -> None:
        self.fake = FakeParcelDataApi()
        self.addCleanup(self.fake.stop)
        self.sleeps: list[float] = []
        self.source = self._source(self.fake.base_url)

    def _source(self, base_url: str, **kwargs: Any) -> ApiParcelSource:
        source = ApiParcelSource(
            base_url,
            TOKEN,
            timeouts=Timeouts(connect=0.5, read=0.5, cohort=0.5, health=0.5),
            sleep=self.sleeps.append,
            **kwargs,
        )
        self.addCleanup(source.close)
        return source

    def _expect(self, error: type[Exception], call: Callable[[], Any]) -> None:
        with (
            self.assertLogs("parcels.sources.http", level="WARNING") as logs,
            self.assertRaises(error),
        ):
            call()
        self.assertNotIn(TOKEN, "\n".join(logs.output))

    # --- requests ---

    def test_sends_the_service_token_under_the_base_path(self) -> None:
        self.fake.reply(200, [{"id": 1}])

        rows = self.source.in_bbox(-86.1, 42.2, -86.0, 42.3, 50)

        self.assertEqual(rows, [{"id": 1}])
        request = self.fake.requests[0]
        self.assertEqual(request["headers"]["Authorization"], f"Token {TOKEN}")
        self.assertTrue(request["path"].startswith("/v-test/" + PATHS["bbox"] + "?"))

    def test_the_token_prefix_is_configurable(self) -> None:
        source = self._source(self.fake.base_url, token_prefix="Bearer")
        self.fake.reply(200, [])

        source.search(["smith"], 8)

        self.assertEqual(self.fake.requests[0]["headers"]["Authorization"], f"Bearer {TOKEN}")

    def test_forwards_the_request_id(self) -> None:
        self.fake.reply(200, [])

        with patch("parcels.sources.http.current_request_id", return_value="req-12345678"):
            self.source.history(7, 10)

        self.assertEqual(self.fake.requests[0]["headers"]["X-Request-ID"], "req-12345678")

    def test_a_missing_parcel_is_none(self) -> None:
        self.fake.reply(404, {"detail": "Not found."})

        self.assertIsNone(self.source.get_parcel(99))

    def test_cohort_posts_the_selector_and_returns_its_parts(self) -> None:
        selector = {"type": "explicit", "ids": [1, 2]}
        self.fake.reply(200, {"rows": [{"id": 1}], "center": {"lng": -86, "lat": 42}, "pin": None})

        result = self.source.cohort(selector, 100)

        self.assertEqual(result.rows, [{"id": 1}])
        self.assertEqual(result.center, {"lng": -86, "lat": 42})
        request = self.fake.requests[0]
        self.assertEqual(request["method"], "POST")
        self.assertEqual(json.loads(request["body"]), {"selector": selector, "limit": 100})

    # --- retries ---

    def test_a_gateway_error_is_retried_once(self) -> None:
        self.fake.reply(502)
        self.fake.reply(200, [{"id": 3}])

        self.assertEqual(self.source.search(["smith"], 8), [{"id": 3}])
        self.assertEqual(len(self.fake.requests), 2)
        self.assertEqual(len(self.sleeps), 1)

    def test_a_second_gateway_error_is_unavailable(self) -> None:
        self.fake.reply(503)
        self.fake.reply(503)

        self._expect(ParcelSourceUnavailable, lambda: self.source.search(["smith"], 8))
        self.assertEqual(len(self.fake.requests), 2)

    def test_a_server_error_is_not_retried(self) -> None:
        self.fake.reply(500)

        self._expect(ParcelSourceUnavailable, lambda: self.source.search(["smith"], 8))
        self.assertEqual(len(self.fake.requests), 1)

    def test_cohort_is_not_retried(self) -> None:
        self.fake.reply(503)

        self._expect(ParcelSourceUnavailable, lambda: self.source.cohort({"type": "x"}, 5))
        self.assertEqual(len(self.fake.requests), 1)

    def test_a_refused_connection_is_retried_then_unavailable(self) -> None:
        with socket.socket() as sock:  # a port nothing listens on
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        source = self._source(f"http://127.0.0.1:{port}")

        self._expect(ParcelSourceUnavailable, lambda: source.search(["smith"], 8))
        self.assertEqual(len(self.sleeps), 1)

    # --- errors ---

    def test_a_slow_answer_is_busy_and_not_retried(self) -> None:
        self.fake.reply(200, [], delay=1.5)

        self._expect(ParcelSourceBusy, lambda: self.source.search(["smith"], 8))
        self.assertEqual(len(self.fake.requests), 1)

    def test_a_rate_limit_is_busy(self) -> None:
        self.fake.reply(429, {"detail": "slow down"})

        self._expect(ParcelSourceBusy, lambda: self.source.search(["smith"], 8))
        self.assertEqual(len(self.fake.requests), 1)

    def test_a_refused_token_is_unavailable_and_logged_as_an_error(self) -> None:
        self.fake.reply(401, {"detail": "Invalid token."})

        with (
            self.assertLogs("parcels.sources.http", level="ERROR") as logs,
            self.assertRaises(ParcelSourceUnavailable),
        ):
            self.source.search(["smith"], 8)
        self.assertNotIn(TOKEN, "\n".join(logs.output))

    def test_a_rejected_cohort_area_is_rejected(self) -> None:
        self.fake.reply(400, {"detail": "invalid geometry"})

        with self.assertRaises(ParcelSourceRejected):
            self.source.cohort({"type": "drawn-polygon"}, 5)

    def test_any_other_client_error_is_unavailable(self) -> None:
        self.fake.reply(400, {"detail": "bad"})

        self._expect(ParcelSourceUnavailable, lambda: self.source.search(["smith"], 8))

    def test_a_body_that_isnt_json_is_unavailable(self) -> None:
        self.fake.reply(200, b"<html>gateway</html>")

        self._expect(ParcelSourceUnavailable, lambda: self.source.search(["smith"], 8))

    def test_a_body_of_the_wrong_shape_is_unavailable(self) -> None:
        self.fake.reply(200, {"not": "a list"})

        self._expect(ParcelSourceUnavailable, lambda: self.source.search(["smith"], 8))

    def test_a_redirect_is_not_followed(self) -> None:
        self.fake.reply(302, {}, headers={"Location": "https://elsewhere.example/steal"})

        self._expect(ParcelSourceUnavailable, lambda: self.source.search(["smith"], 8))
        self.assertEqual(len(self.fake.requests), 1)

    # --- health ---

    def test_ping_is_cached(self) -> None:
        self.fake.reply(200, {"ok": True})

        self.assertTrue(self.source.ping())
        self.assertTrue(self.source.ping())
        self.assertEqual(len(self.fake.requests), 1)

    def test_ping_is_false_when_down_and_never_raises(self) -> None:
        self.fake.reply(503)

        with self.assertLogs("parcels.sources.http", level="WARNING"):
            self.assertFalse(self._source(self.fake.base_url, health_cache_s=0).ping())


class ApiParcelSourceConfigTests(SimpleTestCase):
    def test_plain_http_is_refused_except_to_loopback(self) -> None:
        for url in ("http://parcel-data-api.example", "ftp://x", ""):
            with self.subTest(url), self.assertRaises(ImproperlyConfigured):
                ApiParcelSource(url, TOKEN)

    def test_https_and_loopback_are_accepted(self) -> None:
        for url in ("https://parcel-data-api.example/v1", "http://localhost:8000"):
            with self.subTest(url):
                ApiParcelSource(url, TOKEN).close()

    def test_a_token_is_required(self) -> None:
        with self.assertRaises(ImproperlyConfigured):
            ApiParcelSource("https://parcel-data-api.example", "")

    def test_absolute_paths_are_refused(self) -> None:
        source = ApiParcelSource("https://parcel-data-api.example", TOKEN)
        self.addCleanup(source.close)
        for path in ("https://elsewhere.example/x", "/rooted"):
            with self.subTest(path), self.assertRaises(ValueError):
                source._send("GET", path, retry=False)
