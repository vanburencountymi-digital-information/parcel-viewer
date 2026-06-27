"""run_cost_cache_test.py — AI result-cache for cost governance (C3 / DIC-584).

The cache that makes "the same parcel explained twice shouldn't pay twice" true. Pure
logic — no model, no DB: key stability/tenant-scoping, hit/miss, TTL expiry (injected
clock, no sleep), and LRU eviction.
"""
import sys
import unittest
from pathlib import Path

MB_BACKEND = Path(__file__).resolve().parents[2] / "map-buddy" / "backend"
sys.path.insert(0, str(MB_BACKEND))

import cache as C  # noqa: E402


class CacheKeyTest(unittest.TestCase):
    def test_key_is_stable_and_order_independent(self):
        a = C.cache_key("explain:assessment", "vbc", {"pin": "1", "av": 100})
        b = C.cache_key("explain:assessment", "vbc", {"av": 100, "pin": "1"})  # reordered
        self.assertEqual(a, b)

    def test_key_separates_tenants(self):
        # Same capability + same input but different tenants → different keys (C1 safety).
        vbc = C.cache_key("explain:assessment", "VBC", {"pin": "1"})
        sjc = C.cache_key("explain:assessment", "SJC", {"pin": "1"})
        self.assertNotEqual(vbc, sjc)

    def test_key_separates_capabilities_and_inputs(self):
        self.assertNotEqual(
            C.cache_key("explain:assessment", "t", {"pin": "1"}),
            C.cache_key("explain:tax", "t", {"pin": "1"}),
        )
        self.assertNotEqual(
            C.cache_key("explain:assessment", "t", {"pin": "1"}),
            C.cache_key("explain:assessment", "t", {"pin": "2"}),
        )


class ResultCacheTest(unittest.TestCase):
    def test_hit_and_miss(self):
        rc = C.ResultCache(max_size=4, ttl_seconds=100, clock=lambda: 0)
        self.assertIsNone(rc.get("k"))            # miss
        rc.set("k", {"explanation": "x"})
        self.assertEqual(rc.get("k"), {"explanation": "x"})   # hit

    def test_ttl_expiry_with_injected_clock(self):
        now = [0]
        rc = C.ResultCache(max_size=4, ttl_seconds=10, clock=lambda: now[0])
        rc.set("k", "v")
        now[0] = 9
        self.assertEqual(rc.get("k"), "v")        # still fresh
        now[0] = 10
        self.assertIsNone(rc.get("k"))            # expired (and evicted)
        self.assertEqual(len(rc), 0)

    def test_lru_eviction_at_capacity(self):
        rc = C.ResultCache(max_size=2, ttl_seconds=1000, clock=lambda: 0)
        rc.set("a", 1)
        rc.set("b", 2)
        self.assertEqual(rc.get("a"), 1)          # touch a → b is now LRU
        rc.set("c", 3)                            # evicts b
        self.assertIsNone(rc.get("b"))
        self.assertEqual(rc.get("a"), 1)
        self.assertEqual(rc.get("c"), 3)
        self.assertEqual(len(rc), 2)

    def test_singleton_and_toggle_present(self):
        self.assertIsInstance(C.enabled(), bool)
        self.assertIs(C.get_cache(), C.get_cache())   # stable singleton


if __name__ == "__main__":
    unittest.main()
