"""The budget on the parcel routes: Open untouched, Observe counts, Protected withholds (ADR 0015)."""

import datetime
import threading
from unittest.mock import create_autospec, patch

from django.contrib.auth import get_user_model
from django.db import connections
from django.test import TestCase, TransactionTestCase, override_settings
from knox.models import AuthToken
from rest_framework.test import APIClient

from access import meter, policy
from access.models import DetailUsage
from common.enums import DatabaseAlias
from parcels.repositories import ParcelRepository


def bbox_row(i: int) -> dict:
    return {
        "id": i, "pin": f"80-{i}", "parcel_no": f"80-{i}", "municipality": "Paw Paw",
        "gis_acres": 1.0, "source": "x", "owner_name": f"OWNER {i}", "PCOMBINED": f"{i} MAIN",
        "prop_class": "401", "school_dist": "80010", "assessed_value": 1000 + i,
        "taxable_value": 900 + i, "geojson": '{"type":"Point","coordinates":[0,0]}',
    }  # fmt: skip


def search_row(i: int) -> dict:
    return {
        "id": i, "parcel_no": f"80-{i}", "owner_name": f"OWNER {i}", "prop_street": "1 MAIN",
        "prop_city": "PAW PAW", "municipality": "Paw Paw", "acres": 1.0,
        "w": 0, "s": 0, "e": 1, "n": 1,
    }  # fmt: skip


def parcel_row() -> dict:
    row = bbox_row(7)
    row.update(
        computed_acres=1.0, acres=1.0, prop_street="7 MAIN", assessing_loaded_at=None,
        owner_street="9 MAILING RD", owner_city="X", owner_state="MI", owner_zip="49079",
        prev_assessed_value=1, assessed_value_yr0=1, legal_description="LOT 7",
        tax_description="T", ps_legal_description="L", homestead="100",
    )  # fmt: skip
    return row


BBOX = "/parcels?bbox=-86.1,42.2,-86.0,42.3"


class MeteredRouteTestCase(TestCase):
    """The repository is mocked; the counter is the real table in the test database."""

    def setUp(self) -> None:
        policy.clear_cache()
        self.addCleanup(policy.clear_cache)
        self.repository = create_autospec(ParcelRepository, instance=True)
        patcher = patch("parcels.views.ParcelRepository", return_value=self.repository)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.client = APIClient(HTTP_X_REAL_IP="203.0.113.5")

    def bbox(self, n: int, **headers: str):
        self.repository.in_bbox.return_value = [bbox_row(i) for i in range(n)]
        return self.client.get(BBOX, **headers)


class OpenTests(MeteredRouteTestCase):
    def test_open_responses_are_untouched_and_nothing_is_counted(self) -> None:
        response = self.bbox(3)

        self.assertNotIn("details_withheld", response.json())
        self.assertNotIn("X-Detail-Budget-Limit", response)
        self.assertEqual(response.json()["features"][0]["properties"]["owner_name"], "OWNER 0")
        self.assertFalse(DetailUsage.objects.exists())


@override_settings(ACCESS_MODE_OVERRIDE="observe", ACCESS_DEFAULT_BUDGET=2)
class ObserveTests(MeteredRouteTestCase):
    def test_observe_counts_but_never_withholds_or_adds_headers(self) -> None:
        with self.assertLogs("access.meter", level="WARNING"):
            response = self.bbox(5)

        props = [f["properties"]["owner_name"] for f in response.json()["features"]]
        self.assertEqual(props, [f"OWNER {i}" for i in range(5)])
        self.assertNotIn("X-Detail-Budget-Limit", response)
        self.assertEqual(DetailUsage.objects.get().count, 5)


@override_settings(ACCESS_MODE_OVERRIDE="protected", ACCESS_DEFAULT_BUDGET=10)
class ProtectedTests(MeteredRouteTestCase):
    def test_within_the_budget_everything_is_sent_with_budget_headers(self) -> None:
        response = self.bbox(4)

        self.assertNotIn("details_withheld", response.json())
        self.assertEqual(response.json()["features"][3]["properties"]["assessed_value"], 1003)
        self.assertEqual(response["X-Detail-Budget-Limit"], "10")
        self.assertEqual(response["X-Detail-Budget-Remaining"], "6")
        self.assertIn("X-Detail-Budget-Reset", response)

    def test_crossing_the_budget_withholds_only_the_rows_past_it(self) -> None:
        self.bbox(8)
        with self.assertLogs("access.meter", level="WARNING"):
            response = self.bbox(5)

        features = response.json()["features"]
        self.assertEqual(
            [f["properties"]["owner_name"] for f in features[:2]], ["OWNER 0", "OWNER 1"]
        )
        for f in features[2:]:
            self.assertIsNone(f["properties"]["owner_name"])
            self.assertIsNone(f["properties"]["taxable_value"])
            # Shapes and public fields still come through: the map keeps working.
            self.assertIsNotNone(f["geometry"])
            self.assertEqual(f["properties"]["prop_class"], "401")
        # Each withheld row says so, so the viewer can tell "withheld" from "none on record".
        self.assertEqual(
            [f["properties"].get("details_withheld") for f in features],
            [None, None, True, True, True],
        )
        body = response.json()
        self.assertTrue(body["details_withheld"])
        self.assertEqual(body["detail_budget"]["limit"], 10)
        self.assertEqual(response["X-Detail-Budget-Remaining"], "0")

    def test_past_the_budget_every_route_withholds_but_none_fails(self) -> None:
        self.bbox(10)
        self.repository.search.return_value = [search_row(1)]
        self.repository.get_parcel.return_value = parcel_row()
        self.repository.cohort.return_value = [bbox_row(1)]
        self.repository.cohort_center.return_value = None

        search = self.client.get("/search", {"q": "owner"})
        parcel = self.client.get("/parcel/7")
        cohort = self.client.post(
            "/cohort", {"selector": {"type": "explicit", "ids": [1]}}, format="json"
        )

        self.assertEqual(search.status_code, 200)
        self.assertIsNone(search.json()["results"][0]["owner_name"])
        self.assertTrue(search.json()["results"][0]["details_withheld"])
        self.assertTrue(search.json()["details_withheld"])
        props = parcel.json()["properties"]
        self.assertEqual(parcel.status_code, 200)
        for field in (
            "owner_name",
            "owner_street",
            "assessed_value",
            "legal_description",
            "homestead",
        ):
            self.assertIsNone(props[field], field)
        self.assertEqual(props["pin"], "80-7")
        self.assertTrue(parcel.json()["details_withheld"])
        self.assertIsNone(cohort.json()["features"][0]["properties"]["owner_name"])
        self.assertEqual(cohort.json()["selector"]["count"], 1)

    def test_each_client_has_its_own_budget(self) -> None:
        self.bbox(10)

        other = self.bbox(3, HTTP_X_REAL_IP="198.51.100.9")

        self.assertNotIn("details_withheld", other.json())

    def test_the_budget_resets_the_next_day(self) -> None:
        self.bbox(10)
        tomorrow = datetime.date.today() + datetime.timedelta(days=1)
        reset = datetime.datetime.combine(tomorrow + datetime.timedelta(days=1), datetime.time())
        with patch("access.meter._today_and_reset", return_value=(tomorrow, reset)):
            response = self.bbox(3)

        self.assertNotIn("details_withheld", response.json())

    def test_signed_in_staff_are_not_metered(self) -> None:
        staff = get_user_model().objects.create_user("staffer", password="x" * 20, is_staff=True)
        _instance, token = AuthToken.objects.create(staff)

        response = self.bbox(25, HTTP_AUTHORIZATION=f"Token {token}")

        self.assertNotIn("details_withheld", response.json())
        self.assertFalse(DetailUsage.objects.exists())

    def test_a_bad_token_is_just_anonymous_not_a_401(self) -> None:
        response = self.bbox(3, HTTP_AUTHORIZATION="Token not-a-token")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(DetailUsage.objects.get().count, 3)

    @override_settings(ACCESS_SERVICE_KEYS={"mapbuddy": "svc-key"})
    def test_our_own_services_are_not_metered(self) -> None:
        unmetered = self.bbox(25, HTTP_X_PV_SERVICE_KEY="svc-key")
        wrong = self.bbox(1, HTTP_X_PV_SERVICE_KEY="guess")

        self.assertNotIn("details_withheld", unmetered.json())
        self.assertEqual(DetailUsage.objects.get().count, 1)  # only the wrong key was counted
        self.assertEqual(wrong.status_code, 200)

    def test_alerts_fire_once_at_half_and_at_the_limit(self) -> None:
        with self.assertLogs("access.meter", level="WARNING") as logs:
            self.bbox(4)  # 4: under half
            self.bbox(2)  # 6: crosses half
            self.bbox(4)  # 10: reaches the limit
            self.bbox(4)  # 14: already past, no new alert

        self.assertEqual(len(logs.records), 2)
        self.assertIn("50%", logs.output[0])
        self.assertIn("100%", logs.output[1])

    def test_the_counter_stores_no_raw_address(self) -> None:
        self.bbox(1)

        self.assertNotIn("203.0.113.5", DetailUsage.objects.get().client)

    def test_routes_without_owner_or_value_fields_are_not_metered(self) -> None:
        self.repository.history.return_value = []
        self.repository.geographies.return_value = []

        self.client.get("/parcel/7/history")
        self.client.get("/cohort/geographies", {"type": "township"})

        self.assertFalse(DetailUsage.objects.exists())


@override_settings(ACCESS_MODE_OVERRIDE="protected", ACCESS_DEFAULT_BUDGET=1_000_000)
class ConcurrencyTests(TransactionTestCase):
    """Many requests at once must not lose counts: one atomic upsert each."""

    databases = {DatabaseAlias.DEFAULT}

    def test_concurrent_charges_all_land(self) -> None:
        policy.clear_cache()
        self.addCleanup(policy.clear_cache)

        class FakeRequest:
            user = None
            headers = {"X-Real-IP": "203.0.113.7"}
            META: dict = {}

        def charge_many() -> None:
            for _ in range(10):
                meter.charge(FakeRequest(), 3)  # type: ignore[arg-type]
            connections.close_all()

        threads = [threading.Thread(target=charge_many) for _ in range(8)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        self.assertEqual(DetailUsage.objects.get().count, 8 * 10 * 3)
