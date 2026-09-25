import logging
import re
from unittest import TestCase

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient
from parameterized import parameterized

from parcel_viewer.common.request_context import RequestContextMiddleware, current_request_id


def _app() -> FastAPI:
    app = FastAPI()

    @app.get("/echo")
    def echo():
        # Sync route: runs in the threadpool, like the real API routes.
        return {"request_id": current_request_id()}

    @app.get("/status/{code}")
    def status(code: int):
        return JSONResponse({}, status_code=code)

    @app.get("/health")
    def health():
        return {"status": "ok"}

    app.add_middleware(RequestContextMiddleware)
    return app


class RequestContextMiddlewareTests(TestCase):
    def setUp(self) -> None:
        self.client = TestClient(_app())

    def test_generates_an_id_and_returns_it(self) -> None:
        response = self.client.get("/echo")

        request_id = response.headers["x-request-id"]
        self.assertRegex(request_id, r"^[0-9a-f]{32}$")
        self.assertEqual(response.json()["request_id"], request_id)

    def test_keeps_a_safe_caller_id(self) -> None:
        response = self.client.get("/echo", headers={"X-Request-ID": "abc-123.def_456"})

        self.assertEqual(response.headers["x-request-id"], "abc-123.def_456")
        self.assertEqual(response.json()["request_id"], "abc-123.def_456")

    @parameterized.expand([
        ("too_short", "abc"),
        ("too_long", "a" * 65),
        ("log_injection", "abcdefgh\nFAKE LOG LINE"),
        ("spaces", "abcd efgh ijkl"),
    ])
    def test_replaces_an_unsafe_caller_id(self, _name: str, bad_id: str) -> None:
        response = self.client.get("/echo", headers={"X-Request-ID": bad_id})

        self.assertRegex(response.headers["x-request-id"], r"^[0-9a-f]{32}$")

    def test_no_request_id_outside_a_request(self) -> None:
        self.assertIsNone(current_request_id())

    @parameterized.expand([
        ("ok", "/status/200", logging.INFO),
        ("not_found_is_routine", "/status/404", logging.INFO),
        ("rate_limited", "/status/429", logging.WARNING),
        ("client_error", "/status/400", logging.WARNING),
        ("server_error", "/status/500", logging.ERROR),
        ("health_is_quiet", "/health", logging.DEBUG),
    ])
    def test_access_log_level(self, _name: str, path: str, level: int) -> None:
        with self.assertLogs("access", level=logging.DEBUG) as logs:
            self.client.get(path)

        self.assertEqual(logs.records[-1].levelno, level)

    def test_access_log_fields_and_no_query_string(self) -> None:
        with self.assertLogs("access", level=logging.INFO) as logs:
            response = self.client.get("/echo?q=SMITH+JOHN", headers={"X-Real-IP": "203.0.113.9"})

        record = logs.records[-1]
        self.assertEqual(record.http_method, "GET")
        self.assertEqual(record.path, "/echo")
        self.assertEqual(record.status, 200)
        self.assertEqual(record.client_ip, "203.0.113.9")
        self.assertGreaterEqual(record.duration_ms, 0)
        self.assertNotIn("SMITH", record.getMessage())
        self.assertTrue(re.match(r"^[0-9a-f]{32}$", response.headers["x-request-id"]))
