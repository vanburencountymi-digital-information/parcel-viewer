import os
from unittest import TestCase
from unittest.mock import create_autospec, patch

from fastapi.testclient import TestClient
from parameterized import parameterized

import main
from common.error_logging_client import ErrorLoggingClient, get_error_logging_client


class HealthTests(TestCase):
    def test_health_carries_a_request_id(self) -> None:
        response = TestClient(main.app).get("/health")

        self.assertEqual(response.status_code, 200)
        self.assertIn("x-request-id", response.headers)


@patch.dict(os.environ, {"ANTHROPIC_API_KEY": "test-key"})
class ErrorReportingTests(TestCase):
    def setUp(self) -> None:
        main.limiter.reset()
        self.errors = create_autospec(ErrorLoggingClient, instance=True)
        main.app.dependency_overrides[get_error_logging_client] = lambda: self.errors
        self.client = TestClient(main.app)

    def tearDown(self) -> None:
        main.app.dependency_overrides.clear()

    @parameterized.expand([
        ("explain", "/explain", "run_explain", {"topic": "assessment", "facts": {"pin": "1"}}),
        ("describe_cohort", "/describe-cohort", "run_describe_cohort", {"facts": {"parcel_count": 3}}),
    ])
    def test_ai_failure_is_reported_with_a_clean_reply(self, operation, path, target, body) -> None:
        with patch(f"main.{target}", autospec=True, side_effect=RuntimeError("SDK internals")), \
             patch("main._quota_block", autospec=True, return_value=None), \
             patch("main.result_cache.enabled", autospec=True, return_value=False):
            response = self.client.post(path, json=body)

        self.assertEqual(response.status_code, 200)
        self.assertFalse(response.json()["ok"])
        self.assertNotIn("SDK internals", response.text)
        self.errors.report_exception.assert_called_once()
        self.assertEqual(self.errors.report_exception.call_args.kwargs["tags"], {"operation": operation})


class QuotaLoggingTests(TestCase):
    @patch("main.ai_usage.reserve", autospec=True, return_value=(False, 0))
    def test_quota_hit_is_logged(self, _mock_reserve) -> None:
        with self.assertLogs("map_buddy", level="WARNING") as logs:
            blocked = main._quota_block("vanburen")

        self.assertTrue(blocked["degraded"])
        self.assertIn("AI quota exceeded for tenant vanburen", logs.output[-1])
