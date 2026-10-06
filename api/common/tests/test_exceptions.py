"""Outages, load and unknown paths answer as the FastAPI backend did (DIC-1872, DIC-1853, DIC-1855)."""

from unittest.mock import create_autospec, patch

from django.db import OperationalError
from django.test import SimpleTestCase
from parameterized import parameterized
from psycopg.errors import QueryCanceled
from psycopg_pool import PoolTimeout
from rest_framework.test import APIClient

from common.throttles import describe_rate
from parcels.repositories import ParcelRepository


def _wrapped(cause: Exception) -> OperationalError:
    """An OperationalError raised from a psycopg error, as Django's backend wraps them."""
    try:
        raise OperationalError(str(cause)) from cause
    except OperationalError as exc:
        return exc


class DatabaseErrorTests(SimpleTestCase):
    def setUp(self) -> None:
        self.repository = create_autospec(ParcelRepository, instance=True)
        patcher = patch("parcels.views.ParcelRepository", return_value=self.repository)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.client = APIClient(raise_request_exception=False)

    @parameterized.expand(
        [
            ("lost_connection", OperationalError("server closed the connection"), "database unavailable, try again"),
            ("statement_timeout", _wrapped(QueryCanceled("canceling statement")), "database busy, try again"),
            ("pool_exhausted", _wrapped(PoolTimeout("couldn't get a connection")), "database busy, try again"),
        ]
    )  # fmt: skip
    def test_is_a_503_with_fastapis_body_and_a_warning(self, _name, exc, message) -> None:
        self.repository.search.side_effect = exc

        with self.assertLogs("parcel_viewer.api", level="WARNING"):
            response = self.client.get("/search", {"q": "smith"})

        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json(), {"error": message})

    def test_an_unexpected_error_is_a_plain_500_without_internals(self) -> None:
        self.repository.search.side_effect = RuntimeError("secret-internals SELECT owner_name")

        with self.assertLogs("django.request", level="ERROR"):
            response = self.client.get("/search", {"q": "smith"})

        self.assertEqual(response.status_code, 500)
        self.assertEqual(response.content, b"Internal Server Error")
        self.assertTrue(response["Content-Type"].startswith("text/plain"))


class NotFoundTests(SimpleTestCase):
    def test_an_unknown_path_is_fastapis_json_404(self) -> None:
        response = APIClient().get("/no-such-route")

        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.json(), {"detail": "Not Found"})

    def test_a_wrong_method_is_fastapis_405(self) -> None:
        response = APIClient().delete("/parcels?bbox=0,0,1,1")

        self.assertEqual(response.status_code, 405)
        self.assertEqual(response.json(), {"detail": "Method Not Allowed"})


class DescribeRateTests(SimpleTestCase):
    @parameterized.expand(
        [("5/hour", "5 per 1 hour"), ("45/minute", "45 per 1 minute"), ("100/day", "100 per 1 day"), ("2/m", "2 per 1 minute")]
    )  # fmt: skip
    def test_matches_slowapis_wording(self, rate: str, wording: str) -> None:
        self.assertEqual(describe_rate(rate), wording)
