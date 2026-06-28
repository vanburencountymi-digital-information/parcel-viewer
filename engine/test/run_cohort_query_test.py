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

    def test_explicit_pins_build_parcel_no_predicate(self):
        pred, params, resolved = cq.build_predicate({"type": "explicit", "pins": ["80-07-017-025-00"]}, 3000)
        self.assertEqual(pred, "pg.parcel_no = ANY(%s)")
        self.assertEqual(params, [["80-07-017-025-00"]])
        self.assertEqual(resolved["label"], "1 selected parcel")

    def test_explicit_ids_and_pins_are_ORed(self):
        pred, params, resolved = cq.build_predicate({"type": "explicit", "ids": [3], "pins": ["A", "B"]}, 3000)
        self.assertEqual(pred, "(pg.id = ANY(%s) OR pg.parcel_no = ANY(%s))")
        self.assertEqual(params, [[3], ["A", "B"]])
        self.assertEqual(resolved["label"], "3 selected parcels")   # 1 id + 2 pins

    def test_explicit_empty_fails_closed(self):
        with self.assertRaises(cq.CohortSelectorError):
            cq.build_predicate({"type": "explicit", "ids": []}, 3000)
        with self.assertRaises(cq.CohortSelectorError):
            cq.build_predicate({"type": "explicit", "ids": [], "pins": []}, 3000)

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

    # ── named-geography: spatial (subdivision / section) ─────────────────────────
    def test_named_geography_subdivision_by_id_intersects_whitelisted_table(self):
        pred, params, resolved = cq.build_predicate(
            {"type": "named-geography", "geography": "subdivision", "id": 42}, 3000)
        self.assertIn("ST_Intersects(pg.geom", pred)
        self.assertIn("FROM geo.subdivisions WHERE id = %s", pred)
        self.assertIn("pg.geom &&", pred)               # index-friendly bbox pre-filter
        self.assertEqual(params, [42, 42])              # id used in both the && and the intersect
        self.assertEqual(resolved["geography"], "subdivision")
        self.assertEqual(resolved["label"], "subdivision #42")

    def test_named_geography_subdivision_by_name_unions_matches(self):
        pred, params, resolved = cq.build_predicate(
            {"type": "named-geography", "geography": "subdivision", "name": "LAKEVIEW"}, 3000)
        self.assertIn("ST_Union(geom) FROM geo.subdivisions WHERE sub_name = %s", pred)
        self.assertEqual(params, ["LAKEVIEW", "LAKEVIEW"])
        self.assertEqual(resolved["label"], "LAKEVIEW")

    def test_named_geography_section_uses_plss_table(self):
        pred, _, resolved = cq.build_predicate(
            {"type": "named-geography", "geography": "section", "name": "T1S R13W S14"}, 3000)
        self.assertIn("FROM geo.plss_sections WHERE twnrngsec = %s", pred)
        self.assertEqual(resolved["geography"], "section")

    # ── named-geography: attribute (township / school) ──────────────────────────
    def test_named_geography_township_is_a_municipality_attribute_match(self):
        pred, params, resolved = cq.build_predicate(
            {"type": "named-geography", "geography": "township", "name": "Covert Twp"}, 3000)
        self.assertEqual(pred, "pg.municipality = %s")
        self.assertEqual(params, ["Covert Twp"])
        self.assertEqual(resolved["label"], "Covert Twp")

    def test_named_geography_school_is_a_school_dist_attribute_match(self):
        pred, params, resolved = cq.build_predicate(
            {"type": "named-geography", "geography": "school", "name": "South Haven"}, 3000)
        self.assertEqual(pred, "a.school_dist = %s")
        self.assertEqual(params, ["South Haven"])
        self.assertEqual(resolved["label"], "school district South Haven")

    def test_named_geography_unknown_or_empty_fails_closed(self):
        for bad in ({"type": "named-geography", "geography": "county", "name": "x"},
                    {"type": "named-geography", "geography": "subdivision"},
                    {"type": "named-geography", "geography": "township", "name": "  "}):
            with self.assertRaises(cq.CohortSelectorError):
                cq.build_predicate(bad, 3000)

    # ── drawn-polygon ────────────────────────────────────────────────────────────
    def test_drawn_polygon_intersects_transformed_geojson(self):
        poly = {"type": "Polygon", "coordinates": [[[-86.0, 42.2], [-86.0, 42.3], [-85.9, 42.3], [-86.0, 42.2]]]}
        pred, params, resolved = cq.build_predicate({"type": "drawn-polygon", "geometry": poly}, 3000)
        self.assertIn("ST_GeomFromGeoJSON(%s)", pred)
        self.assertIn("2253", pred)                       # transform 4326 → storage SRID
        self.assertEqual(len(params), 2)                  # geojson used in the && and the intersect
        self.assertEqual(params[0], params[1])
        self.assertEqual(resolved["label"], "drawn area")

    def test_drawn_polygon_rejects_non_polygon_and_empty(self):
        for bad in ({"type": "drawn-polygon", "geometry": {"type": "Point", "coordinates": [1, 2]}},
                    {"type": "drawn-polygon", "geometry": {"type": "Polygon", "coordinates": []}},
                    {"type": "drawn-polygon", "geometry": "nope"},
                    {"type": "drawn-polygon"}):
            with self.assertRaises(cq.CohortSelectorError):
                cq.build_predicate(bad, 3000)

    def test_drawn_polygon_rejects_excessive_vertices(self):
        ring = [[float(i), float(i)] for i in range(10001)]
        with self.assertRaises(cq.CohortSelectorError):
            cq.build_predicate({"type": "drawn-polygon", "geometry": {"type": "Polygon", "coordinates": [ring]}}, 3000)

    def test_geography_sources_are_whitelisted_and_consistent(self):
        # The names route trusts these identifiers; assert the shape so a bad edit fails the harness.
        for geo, src in cq.GEOGRAPHY_SOURCES.items():
            self.assertIn(src["kind"], ("spatial", "attribute"))
            if src["kind"] == "spatial":
                self.assertTrue(src["table"].startswith("geo."))
                self.assertIn("id_col", src); self.assertIn("name_col", src)
            else:
                self.assertTrue(src["column"].startswith(("pg.", "a.")))


if __name__ == "__main__":
    unittest.main()
