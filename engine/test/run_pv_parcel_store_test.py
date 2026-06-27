"""run_pv_parcel_store_test.py — PV-side ParcelStore (A6 / DIC-570) harness coverage.

The /parcel route now reads through DiceVbcParcelStore (psycopg3 home, in PV's backend).
Proves WITHOUT a live DB (the row fetch is injected):

  - the store returns the full `raw` row untouched, so the route's GeoJSON Feature is
    byte-for-byte unchanged (behavior preservation);
  - the VBC row maps to the SAME canonical record shape the ZIP backend produces
    (facts-parity, §4.6) — the shared cross-backend contract.
"""
import importlib.util
import unittest
from pathlib import Path

# Load under a unique module name — the ZIP backend also has a `parcel_store.py`, so a
# plain `import parcel_store` would collide in sys.modules depending on test order.
_PV_STORE = Path(__file__).resolve().parents[2] / "backend" / "parcel_viewer" / "stores" / "parcel_store.py"
_spec = importlib.util.spec_from_file_location("pv_parcel_store", _PV_STORE)
_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_mod)
make_parcel_store, _to_canonical = _mod.make_parcel_store, _mod._to_canonical

# A representative VBC joined row as the psycopg3 dict_row cursor would return it.
VBC_DICT = {
    "id": 45154, "parcel_no": "80-07-017-025-00", "county": "Van Buren", "municipality": "Covert Township",
    "acres": 1.0, "area": 43560.0, "computed_acres": 2.31,
    "source": "county", "source_file": "vbc.shp", "cogo_legs": None,
    "ps_legal_description": "LOT 7 ...", "tax_description": "TAX DESC ...",
    "created_at": None, "updated_at": None,
    "owner_name": "KELLY JOHN", "prop_street": "100 Lake St", "prop_city": "Covert", "prop_state": "MI", "prop_zip": "49043",
    "owner_street": "PO BOX 5", "owner_city": "Covert", "owner_state": "MI", "owner_zip": "49043",
    "school_dist": "Covert Public Schools", "prop_class": "401", "homestead": True, "qual_ag": False,
    "frontage": 80.0, "avg_depth": 120.0,
    "assessed_value": 150000, "taxable_value": 90000, "prev_assessed_value": 145000, "prev_taxable_value": 88000,
    "assessed_value_yr0": 140000, "assessed_value_yr1": 138000, "assessed_value_yr2": 136000,
    "assessed_value_yr3": 134000, "assessed_value_yr4": 132000,
    "legal_description": "LOT 7 LEGACY",
    "geojson": '{"type":"Polygon","coordinates":[]}',
}


class PvParcelStoreTest(unittest.TestCase):
    def test_raw_row_is_passed_through_untouched(self):
        store = make_parcel_store(fetch_one=lambda sql, params: dict(VBC_DICT))
        result = store.get_parcel(45154)
        self.assertEqual(result["raw"], VBC_DICT)        # route builds its Feature from this
        self.assertIn("geojson", result["raw"])          # geometry preserved

    def test_store_runs_the_join_keyed_by_id(self):
        captured = {}
        def fake(sql, params):
            captured["sql"] = " ".join(sql.split()); captured["params"] = params
            return dict(VBC_DICT)
        make_parcel_store(fetch_one=fake).get_parcel(45154)
        self.assertIn("FROM geo.parcel_geometry pg", captured["sql"])
        self.assertIn("assessing.vbc_parcels", captured["sql"])
        self.assertIn("WHERE pg.id = %s", captured["sql"])
        self.assertEqual(captured["params"], (45154,))

    def test_canonical_mapping(self):
        c = _to_canonical(VBC_DICT)
        self.assertEqual(c["id"], 45154)
        self.assertEqual(c["pin"], "80-07-017-025-00")
        self.assertEqual(c["county"], "Van Buren")
        self.assertEqual(c["gis_acres"], 2.31)                       # computed acres preferred
        self.assertEqual(c["owner"]["city"], "Covert")
        self.assertEqual(c["site"]["address"], "100 Lake St")
        self.assertIsNone(c["zoning"])
        self.assertEqual(c["assessment"]["current"], {"assessed": 150000, "sev": None, "taxable": 90000})
        self.assertEqual(c["assessment"]["detail"]["rolling"], [140000, 138000, 136000, 134000, 132000])
        self.assertEqual(c["legal_description"], "LOT 7 ...")        # ps_legal_description preferred
        self.assertEqual(c["source_backend"], "dice-vbc")

    def test_canonical_shape_matches_the_cross_backend_contract(self):
        c = _to_canonical(VBC_DICT)
        self.assertEqual(
            set(c),
            {"id", "pin", "county", "municipality", "gis_acres", "owner", "site", "school",
             "prop_class", "zoning", "pre", "legal_description", "assessment", "source_backend"},
        )
        self.assertEqual(set(c["assessment"]["current"]), {"assessed", "sev", "taxable"})
        self.assertEqual(set(c["owner"]), {"name", "address", "city", "state", "zip"})

    def test_missing_returns_none(self):
        self.assertIsNone(make_parcel_store(fetch_one=lambda s, p: None).get_parcel(1))


if __name__ == "__main__":
    unittest.main()
