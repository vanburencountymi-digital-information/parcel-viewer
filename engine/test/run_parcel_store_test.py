"""run_parcel_store_test.py — ParcelStore seam (A6 / DIC-570) harness coverage.

Proves the parcel data-abstraction (the "real cost" of A6) WITHOUT a live DB:

  - ZIP-local (flat `parcels`, by pin) and DICE/VBC (geo.parcel_geometry ⋈
    assessing.vbc_parcels, by id) both normalize to the SAME canonical record shape
    (facts-parity, §4.6) despite sharing no columns or lookup key.
  - The ZIP agent's calling code is unchanged: zip_legacy_view() reproduces the EXACT
    historical get_parcel_info() dict from the canonical record (behavior preservation).

Connection injected + faked → no live DB.
"""
import sys
import unittest
from pathlib import Path

ZIP_BACKEND = Path(__file__).resolve().parents[3] / "ZIP" / "zip-poc" / "backend"
sys.path.insert(0, str(ZIP_BACKEND))

from parcel_store import build_parcel_store, zip_legacy_view  # noqa: E402


class FakeCursor:
    def __init__(self, row):
        self.row = row
        self.executed = []

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def execute(self, sql, params=None):
        self.executed.append((" ".join(sql.split()), list(params) if params else []))

    def fetchone(self):
        return self.row


class FakeConn:
    def __init__(self, row):
        self.row = row
        self.cursors = []

    def cursor(self):
        c = FakeCursor(self.row)
        self.cursors.append(c)
        return c

    def last_sql(self):
        return self.cursors[-1].executed[-1][0]


def store(backend, row):
    conn = FakeConn(row)
    return build_parcel_store(backend, acquire=lambda: conn, release=lambda c: None), conn


# A representative ZIP `parcels` row (21 columns, in the store's SELECT order).
ZIP_ROW = (
    "80-08-032-002-00", "R-1", "Residential", 1.5,
    "Jane Doe", "123 Main St", "Lawton", "456 Oak Ave", "Lawton Schools", "401", 100, 100,
    200000, 195000, 190000, 100000, 97500, 95000, 90000, 88000, 86000,
)

# The ORIGINAL get_parcel_info() mapping (frozen here as the behavior-preservation oracle).
def legacy_oracle(r):
    return {
        "pin": r[0], "zoning": r[1], "zoning_text": r[2],
        "gis_acres": float(r[3]) if r[3] else None,
        "owner_name": r[4], "owner_address": r[5], "owner_city": r[6],
        "owner_address_full": f"{r[5] or ''}, {r[6] or ''} {r[5] and r[6] and 'MI' or ''}".strip(", "),
        "site_address": r[7], "school_name": r[8], "prop_class": r[9],
        "current_pre": r[10], "previous_pre": r[11],
        "assessed_value_2026": r[12], "assessed_value_2025": r[13], "assessed_value_2024": r[14],
        "sev_2026": r[15], "sev_2025": r[16], "sev_2024": r[17],
        "taxable_value_2026": r[18], "taxable_value_2025": r[19], "taxable_value_2024": r[20],
    }


# A representative DICE/VBC joined row (29 columns, in DiceVbcParcelStore.SQL order).
VBC_ROW = (
    7042, "80-08-032-002-00", "Van Buren", "Lawton Township", 1.49, 1.503,    # id..computed_acres
    "LOT 12 ...", "Jane Doe", "456 Oak Ave", "Lawton", "MI", "49065",         # legal, owner_name, prop_*
    "123 Main St", "Lawton", "MI", "49065",                                   # owner_street/city/state/zip
    "Lawton Community Schools", "401", True,                                   # school, class, homestead
    200000, 90000, 195000, 88000,                                             # assessed, taxable, prev_*
    180000, 178000, 176000, 174000, 172000,                                   # yr0..yr4
    "LOT 12 LEGACY",                                                          # legal_description
)


class ParcelStoreTest(unittest.TestCase):
    def test_zip_local_normalizes_to_canonical(self):
        s, conn = store("zip-local", ZIP_ROW)
        rec = s.get_parcel("80-08-032-002-00")
        self.assertIn("FROM parcels WHERE pin = %s", conn.last_sql())
        self.assertEqual(rec["pin"], "80-08-032-002-00")
        self.assertEqual(rec["zoning"], {"code": "R-1", "text": "Residential"})
        self.assertEqual(rec["gis_acres"], 1.5)
        self.assertEqual(rec["owner"]["name"], "Jane Doe")
        self.assertEqual(rec["assessment"]["current"], {"assessed": 200000, "sev": 100000, "taxable": 90000})
        self.assertEqual(rec["assessment"]["detail"]["2024"]["taxable"], 86000)
        self.assertEqual(rec["source_backend"], "zip-local")

    def test_zip_legacy_view_reproduces_original_get_parcel_info(self):
        s, _ = store("zip-local", ZIP_ROW)
        rec = s.get_parcel("80-08-032-002-00")
        self.assertEqual(zip_legacy_view(rec), legacy_oracle(ZIP_ROW))   # exact behavior parity

    def test_zip_legacy_view_handles_nulls_like_the_original(self):
        row = ("P1", None, None, None, None, None, None, None, None, None, None, None,
               None, None, None, None, None, None, None, None, None)
        s, _ = store("zip-local", row)
        self.assertEqual(zip_legacy_view(s.get_parcel("P1")), legacy_oracle(row))

    def test_dice_vbc_normalizes_to_canonical(self):
        s, conn = store("dice-vbc", VBC_ROW)
        rec = s.get_parcel(7042)
        self.assertIn("FROM geo.parcel_geometry pg", conn.last_sql())
        self.assertIn("assessing.vbc_parcels", conn.last_sql())
        self.assertEqual(rec["id"], 7042)
        self.assertEqual(rec["pin"], "80-08-032-002-00")
        self.assertEqual(rec["county"], "Van Buren")
        self.assertEqual(rec["gis_acres"], 1.503)                       # computed acres preferred
        self.assertEqual(rec["owner"], {"name": "Jane Doe", "address": "123 Main St", "city": "Lawton", "state": "MI", "zip": "49065"})
        self.assertEqual(rec["site"]["address"], "456 Oak Ave")
        self.assertIsNone(rec["zoning"])                                # VBC parcels carry no parcel zoning
        self.assertEqual(rec["assessment"]["current"], {"assessed": 200000, "sev": None, "taxable": 90000})
        self.assertEqual(rec["assessment"]["detail"]["rolling"], [180000, 178000, 176000, 174000, 172000])
        self.assertEqual(rec["legal_description"], "LOT 12 ...")        # ps_legal_description preferred
        self.assertEqual(rec["source_backend"], "dice-vbc")

    def test_both_backends_share_the_canonical_shape(self):
        sz, _ = store("zip-local", ZIP_ROW)
        sd, _ = store("dice-vbc", VBC_ROW)
        rz, rd = sz.get_parcel("p"), sd.get_parcel(1)
        self.assertEqual(set(rz), set(rd))                              # identical top-level keys
        self.assertEqual(set(rz["assessment"]["current"]), set(rd["assessment"]["current"]))
        for k in ("owner", "site"):
            self.assertEqual(set(rz[k]), set(rd[k]))

    def test_missing_parcel_returns_none(self):
        s, _ = store("zip-local", None)
        self.assertIsNone(s.get_parcel("nope"))


if __name__ == "__main__":
    unittest.main()
