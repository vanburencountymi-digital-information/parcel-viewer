"""The cohort routes' contract (DIC-587, DIC-588, DIC-1872), with the repository mocked."""

from unittest.mock import create_autospec, patch

from django.db import DataError, InternalError
from django.test import SimpleTestCase
from parameterized import parameterized
from rest_framework.test import APIClient

from parcels import views
from parcels.repositories import ParcelRepository

DRAWN = {
    "selector": {
        "type": "drawn-polygon",
        "geometry": {
            "type": "Polygon",
            "coordinates": [[[-85.91, 42.21], [-85.90, 42.21], [-85.90, 42.22], [-85.91, 42.21]]],
        },
    }
}


class CohortViewTests(SimpleTestCase):
    def setUp(self) -> None:
        self.repository = create_autospec(ParcelRepository, instance=True)
        patcher = patch("parcels.views.ParcelRepository", return_value=self.repository)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.client = APIClient()

    def _post(self, body: object):
        return self.client.post("/cohort", body, format="json")

    @parameterized.expand(
        [
            ("buffer_off_the_globe", {"selector": {"type": "buffer", "lng": 500, "lat": 42, "distance_ft": 300}}, 400),
            ("unknown_selector", {"selector": {"type": "nope"}}, 400),
            ("limit_not_int", {"selector": {}, "limit": "x"}, 422),
            ("selector_null", {"selector": None}, 422),
            ("body_is_a_list", [1], 422),
        ]
    )  # fmt: skip
    def test_rejected_before_the_database(self, _name, body, status) -> None:
        response = self._post(body)

        self.assertEqual(response.status_code, status, response.content)
        self.repository.cohort.assert_not_called()

    def test_database_rejecting_the_area_is_a_400_without_internals(self) -> None:
        for exc in (InternalError("lwgeom: invalid geometry"), DataError("invalid input syntax")):
            with self.subTest(type(exc).__name__):
                self.repository.cohort.side_effect = exc

                with self.assertLogs("parcels.views", level="WARNING"):
                    response = self._post(DRAWN)

                self.assertEqual(response.status_code, 400)
                self.assertEqual(response.json(), {"detail": "that area couldn't be processed"})

    def test_a_buffer_around_a_parcel_is_labelled_by_its_pin(self) -> None:
        self.repository.cohort.return_value = [{"id": 1, "pin": "80-1"}]
        self.repository.cohort_center.return_value = {"lng": -86.0, "lat": 42.3}
        self.repository.parcel_number.return_value = "80-03-015-030-02"

        response = self._post(
            {"selector": {"type": "buffer", "parcel_id": 36534, "distance_ft": 300}}
        )

        self.assertEqual(
            response.json(),
            {
                "selector": {
                    "type": "buffer",
                    "label": "Within 300 ft of parcel 80-03-015-030-02",
                    "count": 1,
                    "center": [-86.0, 42.3],
                },
                "features": [{"id": 1, "properties": {"pin": "80-1"}}],
            },
        )

    @parameterized.expand([("asked_too_many", 99999, 5000), ("zero_means_default", 0, 3000)])
    def test_the_limit_is_clamped(self, _name, asked, used) -> None:
        self.repository.cohort.return_value = []
        self.repository.cohort_center.return_value = None

        self._post({"selector": {"type": "explicit", "ids": [1]}, "limit": asked})

        self.assertEqual(self.repository.cohort.call_args.args[2], used)


class CohortGeographiesViewTests(SimpleTestCase):
    def setUp(self) -> None:
        views._geographies_cache.clear()
        self.addCleanup(views._geographies_cache.clear)
        self.repository = create_autospec(ParcelRepository, instance=True)
        patcher = patch("parcels.views.ParcelRepository", return_value=self.repository)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.client = APIClient()

    def test_cached_and_the_type_is_echoed_as_written(self) -> None:
        self.repository.geographies.return_value = [{"id": None, "name": "Paw Paw Township"}]

        for _ in range(3):
            response = self.client.get("/cohort/geographies", {"type": "Township"})
            self.assertEqual(
                response.json(),
                {"type": "Township", "geographies": [{"id": None, "name": "Paw Paw Township"}]},
            )

        self.assertEqual(self.repository.geographies.call_count, 1)

    def test_unknown_type_is_a_400(self) -> None:
        response = self.client.get("/cohort/geographies", {"type": "county"})

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json(), {"detail": "unknown geography type"})
        self.repository.geographies.assert_not_called()
