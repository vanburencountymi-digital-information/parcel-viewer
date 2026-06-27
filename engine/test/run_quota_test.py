"""run_quota_test.py — per-tenant AI quotas (C3 / DIC-584).

Pure policy logic — no model, no DB: rolling-window metering, per-tenant + per-plan
limits (config-driven), unlimited when no limit is set, and the overage decision that
drives degrade-to-AI-off. Clock injected, so window expiry is tested without sleeping.
"""
import sys
import unittest
from pathlib import Path

MB_BACKEND = Path(__file__).resolve().parents[2] / "map-buddy" / "backend"
sys.path.insert(0, str(MB_BACKEND))

import usage as U  # noqa: E402


class UsageCounterTest(unittest.TestCase):
    def test_counts_within_window_and_prunes_old(self):
        now = [0]
        c = U.UsageCounter(window_seconds=10, clock=lambda: now[0])
        c.record("vbc"); c.record("vbc")
        self.assertEqual(c.count("vbc"), 2)
        now[0] = 11                       # both events now outside the window
        self.assertEqual(c.count("vbc"), 0)

    def test_tenants_are_independent(self):
        c = U.UsageCounter(window_seconds=100, clock=lambda: 0)
        c.record("vbc"); c.record("vbc"); c.record("sjc")
        self.assertEqual(c.count("vbc"), 2)
        self.assertEqual(c.count("sjc"), 1)


class QuotaTest(unittest.TestCase):
    def test_unlimited_when_no_limit(self):
        c = U.UsageCounter(clock=lambda: 0)
        q = U.QuotaConfig(default_limit=None)
        self.assertFalse(q.enabled())
        for _ in range(100):
            allowed, remaining = U.check_quota(c, q, "vbc")
            self.assertTrue(allowed)
            c.record("vbc")

    def test_default_limit_enforced_then_blocks(self):
        now = [0]
        c = U.UsageCounter(window_seconds=1000, clock=lambda: now[0])
        q = U.QuotaConfig(default_limit=2)
        a1, r1 = U.check_quota(c, q, "vbc"); c.record("vbc")
        a2, r2 = U.check_quota(c, q, "vbc"); c.record("vbc")
        a3, r3 = U.check_quota(c, q, "vbc")
        self.assertEqual([a1, a2, a3], [True, True, False])   # 3rd call blocked
        self.assertEqual(r3, 0)

    def test_per_tenant_override_beats_default(self):
        c = U.UsageCounter(clock=lambda: 0)
        q = U.QuotaConfig(default_limit=1, overrides={"vbc": 5})  # a "paid tier" for vbc
        self.assertEqual(q.limit_for("vbc"), 5)
        self.assertEqual(q.limit_for("sjc"), 1)
        self.assertTrue(q.enabled())

    def test_quota_frees_up_as_the_window_rolls(self):
        now = [0]
        c = U.UsageCounter(window_seconds=10, clock=lambda: now[0])
        q = U.QuotaConfig(default_limit=1)
        self.assertTrue(U.check_quota(c, q, "vbc")[0]); c.record("vbc")
        self.assertFalse(U.check_quota(c, q, "vbc")[0])   # at limit
        now[0] = 11                                        # window rolled past the event
        self.assertTrue(U.check_quota(c, q, "vbc")[0])     # freed up

    def test_overrides_parse_from_env_string(self):
        self.assertEqual(U._parse_overrides("vbc=1000, sjc=500"), {"vbc": 1000, "sjc": 500})
        self.assertEqual(U._parse_overrides(""), {})

    def test_snapshot_shape_for_monitoring(self):
        s = U.snapshot()   # C4 /status payload
        self.assertEqual(set(s), {"enabled", "window_seconds", "default_limit", "overrides", "tenants"})
        self.assertIsInstance(s["tenants"], dict)


if __name__ == "__main__":
    unittest.main()
