import datetime
import uuid
from decimal import Decimal

from django.test import SimpleTestCase

from parcels import presenters


class RollYearTests(SimpleTestCase):
    """/parcel/{id} says which tax roll its value history ends at (DIC-1878)."""

    def test_roll_year_comes_from_the_load_date_not_the_calendar(self) -> None:
        self.assertEqual(presenters.roll_year_for_load(datetime.datetime(2027, 2, 10)), 2026)
        self.assertEqual(presenters.roll_year_for_load(datetime.datetime(2027, 4, 1)), 2027)

    def test_unknown_load_date_has_no_roll_year(self) -> None:
        self.assertIsNone(presenters.roll_year_for_load(None))


class ParcelFeatureTests(SimpleTestCase):
    def _row(self, **changes) -> dict:
        row = {
            "id": 7,
            "parcel_no": "80-01-001-001-00",
            "acres": 1.0,
            "computed_acres": 1.2,
            "prop_street": "1 MAIN ST",
            "created_at": None,
            "updated_at": None,
            "assessing_loaded_at": datetime.datetime(2027, 2, 10, tzinfo=datetime.UTC),
            "geojson": '{"type":"Point","coordinates":[-86.0,42.3]}',
        }
        row.update(changes)
        return row

    def test_derived_properties_and_geometry(self) -> None:
        feature = presenters.parcel_feature(self._row())

        self.assertEqual(feature["id"], 7)
        self.assertEqual(feature["geometry"], {"type": "Point", "coordinates": [-86.0, 42.3]})
        props = feature["properties"]
        self.assertEqual(props["pin"], "80-01-001-001-00")
        self.assertEqual(props["gis_acres"], 1.2)
        self.assertEqual(props["PCOMBINED"], "1 MAIN ST")
        self.assertEqual(props["roll_year"], 2026)
        self.assertEqual(props["assessing_loaded_at"], "2027-02-10T00:00:00+00:00")
        self.assertNotIn("geojson", props)

    def test_stored_acres_when_the_geometry_area_is_unknown(self) -> None:
        feature = presenters.parcel_feature(self._row(computed_acres=None))

        self.assertEqual(feature["properties"]["gis_acres"], 1.0)


class HistoryTests(SimpleTestCase):
    def test_ids_and_timestamps_become_strings_and_closure_a_float(self) -> None:
        event_id = uuid.uuid4()
        rows = [
            {"event_id": event_id, "event_timestamp": None, "closure_error": Decimal("0.02")},
        ]

        events = presenters.history_events(rows)["events"]

        self.assertEqual(events[0]["event_id"], str(event_id))
        self.assertIsNone(events[0]["event_timestamp"])
        self.assertEqual(events[0]["closure_error"], 0.02)


class SearchResultTests(SimpleTestCase):
    def test_address_joins_street_and_city_and_skips_blanks(self) -> None:
        row = {
            "id": 1,
            "parcel_no": "80-1",
            "owner_name": "SMITH",
            "prop_street": None,
            "prop_city": "BANGOR",
            "municipality": "Arlington Township",
            "acres": 2.0,
            "w": 1,
            "s": 2,
            "e": 3,
            "n": 4,
        }

        result = presenters.search_results([row])["results"][0]

        self.assertEqual(result["address"], "BANGOR")
        self.assertEqual(result["bbox"], [1, 2, 3, 4])


class StreetViewTests(SimpleTestCase):
    def test_looks_from_the_road_at_the_address_point(self) -> None:
        row = {
            "anchor_lng": -86.05,
            "anchor_lat": 42.30,
            "road_lng": -86.051,
            "road_lat": 42.301,
            "address": "32791 52ND ST",
            "has_address": True,
        }

        self.assertEqual(
            presenters.streetview_target(row),
            {
                "ok": True,
                "viewpoint": [-86.051, 42.301],
                "lookAt": [-86.05, 42.30],
                "address": "32791 52ND ST",
                "hasAddress": True,
            },
        )

    def test_without_a_road_it_stands_on_the_anchor(self) -> None:
        row = {"anchor_lng": -86.0, "anchor_lat": 42.0, "road_lng": None, "road_lat": None}

        self.assertEqual(presenters.streetview_target(row)["viewpoint"], [-86.0, 42.0])

    def test_unknown_parcel_is_not_ok(self) -> None:
        self.assertEqual(presenters.streetview_target({"anchor_lng": None}), {"ok": False})
        self.assertEqual(presenters.streetview_target(None), {"ok": False})


class NearestRoadTests(SimpleTestCase):
    def test_no_road_returns_the_point_unsnapped(self) -> None:
        self.assertEqual(
            presenters.nearest_road(None, -86.0, 42.0),
            {"lng": -86.0, "lat": 42.0, "snapped": False},
        )
