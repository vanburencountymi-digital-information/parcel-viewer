from unittest.mock import patch

from django.test import SimpleTestCase
from rest_framework.test import APIClient

from common.services import HealthReport
from common.views import HealthView


class HealthViewTests(SimpleTestCase):
    """The FastAPI /health contract: {"status", "db"}, 200 or 503 (DIC-1879)."""

    def setUp(self) -> None:
        self.client = APIClient()

    @patch("common.views.HealthService", autospec=True)
    def test_healthy_is_a_200_with_db_true(self, mock_service) -> None:
        mock_service.return_value.check.return_value = HealthReport(ok=True)

        response = self.client.get("/health")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"status": "ok", "db": True})

    @patch("common.views.HealthService", autospec=True)
    def test_database_down_is_a_503_with_db_false(self, mock_service) -> None:
        mock_service.return_value.check.return_value = HealthReport(ok=False)

        response = self.client.get("/health")

        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json(), {"status": "degraded", "db": False})

    def test_a_trailing_slash_is_not_redirected(self) -> None:
        # The FastAPI paths have no trailing slash; Django must not add one (ADR 0011).
        self.assertEqual(self.client.get("/health/").status_code, 404)

    def test_it_is_public_and_rate_limited(self) -> None:
        self.assertEqual(HealthView.authentication_classes, [])
        self.assertTrue(HealthView.throttle_classes)


class ApiDocsTests(SimpleTestCase):
    def test_schema_and_docs_are_staff_only(self) -> None:
        client = APIClient()

        for path in ("/schema", "/docs"):
            with self.subTest(path):
                self.assertIn(client.get(path).status_code, (401, 403))
