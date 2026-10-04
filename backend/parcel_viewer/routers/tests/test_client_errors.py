from unittest import TestCase

from fastapi.testclient import TestClient
from parameterized import parameterized

from app import main
from parcel_viewer.ratelimit import limiter

VALID = {
    "kind": "error",
    "message": "TypeError: x is undefined",
    "source": "http://127.0.0.1:8080/frontend/public/js/map.js",
    "line": 120,
    "column": 7,
    "page": "/demo/",
}


class ClientErrorsTests(TestCase):
    def setUp(self) -> None:
        limiter.reset()
        self.client = TestClient(main.app)

    def test_logs_a_valid_report(self) -> None:
        with self.assertLogs("parcel_viewer.routers.client_errors", level="WARNING") as logs:
            response = self.client.post("/client-errors", json=VALID, headers={"User-Agent": "TestBrowser/1"})

        self.assertEqual(response.status_code, 204)
        record = logs.records[-1]
        self.assertIn("TypeError: x is undefined", record.getMessage())
        self.assertEqual(record.browser_error_kind, "error")
        self.assertEqual(record.browser_page, "/demo/")
        self.assertEqual(record.user_agent, "TestBrowser/1")

    @parameterized.expand([
        ("message_too_long", {"message": "x" * 501}),
        ("unknown_kind", {"kind": "warning"}),
        ("negative_line", {"line": -1}),
        ("source_too_long", {"source": "s" * 301}),
    ])
    def test_rejects_bad_reports(self, _name: str, change: dict) -> None:
        response = self.client.post("/client-errors", json={**VALID, **change})

        self.assertEqual(response.status_code, 422)

    def test_rate_limited_per_client(self) -> None:
        codes = [self.client.post("/client-errors", json=VALID).status_code for _ in range(21)]

        self.assertEqual(codes[:20], [204] * 20)
        self.assertEqual(codes[20], 429)
