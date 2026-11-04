"""The parcel source seam (DIC-2802): selection, the SQL source's cohort, settings checks,
and source errors answered as today's database errors."""

from unittest.mock import create_autospec, patch

from django.db import DataError
from django.test import SimpleTestCase, override_settings
from rest_framework.test import APIClient

from parcels.checks import parcel_source_settings
from parcels.repositories import ParcelRepository
from parcels.sources import CohortResult, get_parcel_source, reset_parcel_source
from parcels.sources.errors import ParcelSourceBusy, ParcelSourceRejected, ParcelSourceUnavailable
from parcels.sources.http import ApiParcelSource
from parcels.sources.sql import SqlParcelSource

API_SETTINGS = {
    "PARCEL_SOURCE": "api",
    "PARCEL_DATA_API_BASE": "https://parcel-data-api.example",
    "PARCEL_DATA_API_TOKEN": "t0ken",
}


class GetParcelSourceTests(SimpleTestCase):
    def setUp(self) -> None:
        reset_parcel_source()
        self.addCleanup(reset_parcel_source)

    def test_sql_is_the_default(self) -> None:
        self.assertIsInstance(get_parcel_source(), SqlParcelSource)

    @override_settings(**API_SETTINGS)
    def test_api_is_built_once_per_process(self) -> None:
        source = get_parcel_source()

        self.assertIsInstance(source, ApiParcelSource)
        self.assertIs(get_parcel_source(), source)


class SqlParcelSourceCohortTests(SimpleTestCase):
    def setUp(self) -> None:
        self.repository = create_autospec(ParcelRepository, instance=True)
        self.source = SqlParcelSource(self.repository)

    def test_builds_the_predicate_and_looks_up_a_buffer_parcels_pin(self) -> None:
        self.repository.cohort.return_value = [{"id": 1}]
        self.repository.cohort_center.return_value = {"lng": -86.0, "lat": 42.3}
        self.repository.parcel_number.return_value = "80-1"

        result = self.source.cohort({"type": "buffer", "parcel_id": 5, "distance_ft": 300}, 10)

        self.assertEqual(
            result, CohortResult(rows=[{"id": 1}], center={"lng": -86.0, "lat": 42.3}, pin="80-1")
        )
        predicate, params, limit = self.repository.cohort.call_args.args
        self.assertIn("ST_DWithin", predicate)
        self.assertEqual((params, limit), ([5, 300.0], 10))

    def test_no_pin_for_other_selectors(self) -> None:
        self.repository.cohort.return_value = []

        result = self.source.cohort({"type": "explicit", "ids": [1]}, 10)

        self.assertIsNone(result.pin)
        self.repository.parcel_number.assert_not_called()

    def test_postgis_rejecting_the_area_is_rejected(self) -> None:
        self.repository.cohort.side_effect = DataError("invalid input syntax")

        with self.assertRaises(ParcelSourceRejected):
            self.source.cohort({"type": "explicit", "ids": [1]}, 10)


class ChecksTests(SimpleTestCase):
    def test_sql_needs_nothing(self) -> None:
        self.assertEqual(parcel_source_settings(), [])

    @override_settings(PARCEL_SOURCE="postgres")
    def test_an_unknown_source_fails(self) -> None:
        self.assertEqual([e.id for e in parcel_source_settings()], ["parcels.E001"])

    @override_settings(PARCEL_SOURCE="api", PARCEL_DATA_API_BASE="http://x.example", PARCEL_DATA_API_TOKEN="")  # fmt: skip
    def test_api_needs_an_https_base_and_a_token(self) -> None:
        self.assertEqual([e.id for e in parcel_source_settings()], ["parcels.E002", "parcels.E003"])

    @override_settings(**API_SETTINGS)
    def test_api_configured(self) -> None:
        self.assertEqual(parcel_source_settings(), [])


class SourceErrorResponseTests(SimpleTestCase):
    """Whatever the source, the browser gets today's bodies (ADR 0011)."""

    def setUp(self) -> None:
        self.source = create_autospec(SqlParcelSource, instance=True)
        patcher = patch("parcels.views.get_parcel_source", return_value=self.source)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.client = APIClient(raise_request_exception=False)

    def test_unavailable_and_busy_are_todays_503s(self) -> None:
        for exc, message in (
            (ParcelSourceUnavailable("x"), "database unavailable, try again"),
            (ParcelSourceBusy("x"), "database busy, try again"),
        ):
            with self.subTest(type(exc).__name__):
                self.source.in_bbox.side_effect = exc

                response = self.client.get("/parcels", {"bbox": "-86.1,42.2,-86.0,42.3"})

                self.assertEqual(response.status_code, 503)
                self.assertEqual(response.json(), {"error": message})

    def test_a_rejected_cohort_area_is_todays_400(self) -> None:
        self.source.cohort.side_effect = ParcelSourceRejected("x")

        with self.assertLogs("parcels.views", level="WARNING"):
            response = self.client.post(
                "/cohort", {"selector": {"type": "explicit", "ids": [1]}}, format="json"
            )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json(), {"detail": "that area couldn't be processed"})
