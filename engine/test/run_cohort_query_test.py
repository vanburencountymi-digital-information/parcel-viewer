"""run_cohort_query_test.py — cohort selector → SQL predicate builder (DIC-587).

Proves the spatial-selection half of the cohort capability (backend/parcel_viewer/
cohort_query.py) builds correct, parameterized predicates and fails closed on malformed
selectors — WITHOUT a database (the module has no DB imports; loaded directly so the
parcel_viewer package __init__ / db pool never run).
"""
import importlib.util
import unittest
from pathlib import Path

_CQ_PATH = Path(__file__).resolve().parents[2] / "backend" / "parcel_viewer" / "cohort_query.py"
_spec = importlib.util.spec_from_file_location("cohort_query", _CQ_PATH)
cq = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(cq)


class CohortQueryTest(unittest.TestCase):
    def test_explicit_ids_build_any_predicate(self):
        pred, params, resolved = cq.build_predicate({"type": "explicit", "ids": [3, 7, 9]}, 3000)
        self.assertEqual(pred, "pg.id = ANY(%s)")
        self.assertEqual(params, [[3, 7, 9]])
        self.assertEqual(resolved["type"], "explicit")
        self.assertEqual(resolved["label"], "3 selected parcels")

    def test_explicit_single_is_singular(self):
        _, _, resolved = cq.build_predicate({"type": "explicit", "ids": ["12"]}, 3000)
        self.assertEqual(resolved["label"], "1 selected parcel")   # coerces str→int too

    def test_explicit_respects_limit(self):
        _, params, _ = cq.build_predicate({"type": "explicit", "ids": list(range(10))}, 4)
        self.assertEqual(params[0], [0, 1, 2, 3])

    def test_explicit_empty_fails_closed(self):
        with self.assertRaises(cq.CohortSelectorError):
            cq.build_predicate({"type": "explicit", "ids": []}, 3000)

    def test_explicit_non_integer_rejected(self):
        with self.assertRaises(cq.CohortSelectorError):
            cq.build_predicate({"type": "explicit", "ids": ["abc"]}, 3000)

    def test_buffer_around_parcel_uses_feet_directly(self):
        pred, params, resolved = cq.build_predicate(
            {"type": "buffer", "parcel_id": 45154, "distance_ft": 500}, 3000)
        self.assertIn("ST_DWithin(pg.geom", pred)
        self.assertIn("FROM geo.parcel_geometry WHERE id = %s", pred)   # anchor parcel subquery
        self.assertEqual(params, [45154, 500.0])                         # [id, distance_ft]
        self.assertEqual(resolved["label"], "Within 500 ft of parcel 45154")

    def test_buffer_around_point_transforms_to_2253(self):
        pred, params, resolved = cq.build_predicate(
            {"type": "buffer", "lng": -86.03, "lat": 42.24, "distance_ft": 250}, 3000)
        self.assertIn("ST_MakePoint(%s, %s)", pred)
        self.assertIn("2253", pred)                       # transform into the storage SRID
        self.assertEqual(params, [-86.03, 42.24, 250.0])  # [lng, lat, distance_ft]
        self.assertEqual(resolved["label"], "Within 250 ft of a point")

    def test_buffer_requires_positive_distance(self):
        for bad in ({"type": "buffer", "parcel_id": 1, "distance_ft": 0},
                    {"type": "buffer", "parcel_id": 1, "distance_ft": -5},
                    {"type": "buffer", "parcel_id": 1}):
            with self.assertRaises(cq.CohortSelectorError):
                cq.build_predicate(bad, 3000)

    def test_buffer_requires_anchor(self):
        with self.assertRaises(cq.CohortSelectorError):
            cq.build_predicate({"type": "buffer", "distance_ft": 100}, 3000)

    def test_unknown_selector_type_rejected(self):
        with self.assertRaises(cq.CohortSelectorError):
            cq.build_predicate({"type": "lasso"}, 3000)
        with self.assertRaises(cq.CohortSelectorError):
            cq.build_predicate({}, 3000)


if __name__ == "__main__":
    unittest.main()
