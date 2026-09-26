"""Cohort selector validation (DIC-1872): bad input must be a 400, never a PostGIS 500.

Each case below reached the database and failed with a 500 before this change.
"""

import json
from unittest import TestCase

from parameterized import parameterized

from parcel_viewer.cohort_query import MAX_BUFFER_FT, CohortSelectorError, build_predicate

SQUARE = [[-85.91, 42.21], [-85.90, 42.21], [-85.90, 42.22], [-85.91, 42.22], [-85.91, 42.21]]


def _drawn(coordinates, gtype="Polygon") -> dict:
    return {"type": "drawn-polygon", "geometry": {"type": gtype, "coordinates": coordinates}}


class RejectedInputTests(TestCase):
    @parameterized.expand(
        [
            (
                "buffer_lng_out_of_range",
                {"type": "buffer", "lng": 500, "lat": 42.2, "distance_ft": 300},
            ),
            (
                "buffer_lat_out_of_range",
                {"type": "buffer", "lng": -85.9, "lat": 95, "distance_ft": 300},
            ),
            ("buffer_too_big", {"type": "buffer", "lng": -85.9, "lat": 42.2, "distance_ft": 1e308}),
            ("buffer_zero", {"type": "buffer", "lng": -85.9, "lat": 42.2, "distance_ft": 0}),
            ("drawn_garbage", _drawn("garbage")),
            ("drawn_two_points", _drawn([[[-85.9, 42.2], [-85.8, 42.3]]])),
            ("drawn_lng_900", _drawn([[[900, 42.2], [-85.8, 42.3], [-85.8, 42.2], [900, 42.2]]])),
            ("drawn_point_not_a_pair", _drawn([[[-85.9], [-85.8, 42.3], [-85.8, 42.2], [-85.9]]])),
            ("drawn_multipolygon_garbage", _drawn(["x"], gtype="MultiPolygon")),
        ]
    )
    def test_is_a_selector_error(self, _name: str, selector: dict) -> None:
        with self.assertRaises(CohortSelectorError):
            build_predicate(selector, 100)


class AcceptedInputTests(TestCase):
    def test_numeric_township_id_is_bound_as_text(self) -> None:
        # township / school district are text columns; an int was compared text = integer.
        _pred, params, resolved = build_predicate(
            {"type": "named-geography", "geography": "school", "id": 80160}, 100
        )
        self.assertEqual(params, ["80160"])
        self.assertIn("80160", resolved["label"])

    def test_buffer_at_the_cap_is_allowed(self) -> None:
        _pred, params, _ = build_predicate(
            {"type": "buffer", "lng": -85.9, "lat": 42.2, "distance_ft": MAX_BUFFER_FT}, 100
        )
        self.assertEqual(params, [-85.9, 42.2, MAX_BUFFER_FT])

    def test_open_ring_is_closed(self) -> None:
        _pred, params, _ = build_predicate(_drawn([SQUARE[:-1]]), 100)

        ring = json.loads(params[0])["coordinates"][0]
        self.assertEqual(ring[0], ring[-1])
        self.assertEqual(len(ring), 5)

    def test_valid_multipolygon(self) -> None:
        _pred, params, resolved = build_predicate(_drawn([[SQUARE]], gtype="MultiPolygon"), 100)

        self.assertEqual(json.loads(params[0])["type"], "MultiPolygon")
        self.assertEqual(resolved["type"], "drawn-polygon")
