"""run_workflow_params_test.py — Map Buddy automation (macro) parameter validation.

Automations expand server-side into map commands with no model call, so their inputs
arrive straight from the UI / the model's tool call and must be validated here:
a negative setback drew an outward ring labelled "-30 ft setback", and 1e9 ft passed.

Zero-dependency: the anthropic SDK is stubbed (same pattern as run_explain_contract_test).
"""

import os
import sys
import types
import unittest
from pathlib import Path

if "anthropic" not in sys.modules:
    _fake = types.ModuleType("anthropic")

    class _FakeAnthropic:  # noqa: N801
        def __init__(self, *a, **k):
            pass

    _fake.Anthropic = _FakeAnthropic
    sys.modules["anthropic"] = _fake

os.environ.setdefault("ANTHROPIC_API_KEY", "test-key")
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "map-buddy" / "backend"))

import agent  # noqa: E402

PIN = "80-14-014-015-00"


def run(setback):
    inp = {"pin": PIN}
    if setback is not ...:
        inp["setback_ft"] = setback
    # No centroid → no environmental lookup (no network in the test).
    return agent._expand_workflow("check_buildability", inp, {})


def buffer_cmd(cmds):
    return next((c for c in cmds if c["type"] == "draw_parcel_buffer"), None)


class WorkflowParams(unittest.TestCase):
    def test_default_setback(self):
        _note, cmds = run(...)
        self.assertEqual(buffer_cmd(cmds)["payload"]["distance_ft"], 30)

    def test_valid_setback(self):
        _note, cmds = run(50)
        self.assertEqual(buffer_cmd(cmds)["payload"]["distance_ft"], 50)
        self.assertEqual(buffer_cmd(cmds)["payload"]["label"], "50 ft setback")

    def test_out_of_range_rejected(self):
        for bad in (-30, 0, 1e9):
            note, cmds = run(bad)
            self.assertEqual(cmds, [], bad)
            self.assertIn("between", note)

    def test_non_numbers_rejected(self):
        for bad in ("abc", True, float("nan"), float("inf")):
            note, cmds = run(bad)
            self.assertEqual(cmds, [], repr(bad))
            self.assertIn("must be a number", note)


if __name__ == "__main__":
    unittest.main()
