"""The parcel routes' contract, as pinned for FastAPI by backend/app/tests (DIC-1874).

The repository is mocked: bad input must be rejected before any database work.
"""

from unittest.mock import create_autospec, patch

from django.test import SimpleTestCase
from parameterized import parameterized
from rest_framework.test import APIClient

from parcels.repositories import ParcelRepository
from parcels.views import PublicParcelView


class ParcelViewTests(SimpleTestCase):
    def setUp(self) -> None:
        self.repository = create_autospec(ParcelRepository, instance=True)
        patcher = patch("parcels.views.ParcelRepository", return_value=self.repository)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.client = APIClient()

    @parameterized.expand(
        [
            ("search_too_long", "/search?q=" + "a" * 101, 422),
            ("search_too_short", "/search?q=a", 422),
            ("search_limit_zero", "/search?q=ab&limit=0", 422),
            ("search_limit_too_big", "/search?q=ab&limit=51", 422),
            ("bbox_not_numbers", "/parcels?bbox=a,b,c,d", 400),
            ("bbox_nan", "/parcels?bbox=nan,0,1,1", 400),
            ("bbox_three_values", "/parcels?bbox=1,2,3", 400),
            ("parcels_limit_zero", "/parcels?bbox=0,0,1,1&limit=0", 422),
            ("parcels_limit_above_4000", "/parcels?bbox=0,0,1,1&limit=4001", 422),
            ("parcel_id_not_int", "/parcel/abc", 422),
            ("history_limit_too_big", "/parcel/1/history?limit=201", 422),
            ("nearest_road_no_coords", "/nearest-road", 422),
            ("nearest_road_not_numbers", "/nearest-road?lng=x&lat=y", 422),
            ("streetview_id_not_int", "/streetview-target?id=x", 422),
        ]
    )
    def test_rejected_before_the_database(self, _name, path, status) -> None:
        response = self.client.get(path)

        self.assertEqual(response.status_code, status, response.content)
        for method in ("get_parcel", "in_bbox", "search", "history", "nearest_road_point"):
            getattr(self.repository, method).assert_not_called()

    def test_unknown_parcel_is_a_404_with_fastapis_detail(self) -> None:
        self.repository.get_parcel.return_value = None

        response = self.client.get("/parcel/999")

        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.json(), {"detail": "Parcel not found"})

    def test_search_uses_at_most_8_words(self) -> None:
        self.repository.search.return_value = []

        self.client.get("/search", {"q": " ".join(f"w{i}" for i in range(20))})

        tokens, _limit = self.repository.search.call_args.args
        self.assertEqual(tokens, [f"w{i}" for i in range(8)])

    def test_a_blank_search_returns_no_results_without_a_query(self) -> None:
        response = self.client.get("/search", {"q": "   "})

        self.assertEqual(response.json(), {"results": []})
        self.repository.search.assert_not_called()

    def test_bbox_is_passed_as_numbers_with_the_default_cap(self) -> None:
        self.repository.in_bbox.return_value = []

        response = self.client.get("/parcels", {"bbox": "-86.1,42.2,-86.0,42.3"})

        self.assertEqual(response.json(), {"type": "FeatureCollection", "features": []})
        self.repository.in_bbox.assert_called_once_with(-86.1, 42.2, -86.0, 42.3, 4000)

    def test_no_trailing_slash_redirects(self) -> None:
        self.assertEqual(self.client.get("/parcels/").status_code, 404)


class PublicParcelViewTests(SimpleTestCase):
    def test_public_and_rate_limited_with_their_own_scope(self) -> None:
        self.assertEqual(PublicParcelView.authentication_classes, [])
        self.assertTrue(PublicParcelView.throttle_classes)
        self.assertEqual(PublicParcelView.throttle_scope, "parcel_read")
