"""Reading a county's data-access policy from its manifest (ADR 0015)."""

from unittest.mock import patch

from django.test import SimpleTestCase, override_settings

from access import policy
from access.policy import AccessMode


class PolicyTests(SimpleTestCase):
    def setUp(self) -> None:
        policy.clear_cache()
        self.addCleanup(policy.clear_cache)

    def _policy(self, access: object):
        with patch("access.policy.published_config", return_value={"access": access}):
            return policy.policy_for("somewhere")

    def test_a_manifest_without_a_mode_is_open(self) -> None:
        for access in ({}, None, {"model": "Public — no sign-in"}):
            policy.clear_cache()
            self.assertEqual(self._policy(access).mode, AccessMode.OPEN, access)

    def test_van_buren_as_shipped_is_open(self) -> None:
        self.assertEqual(policy.policy_for("vanburen").mode, AccessMode.OPEN)

    def test_a_protected_county_reads_its_budget_and_links(self) -> None:
        p = self._policy(
            {
                "mode": "protected",
                "detailBudget": 1200,
                "dataUrl": "https://d",
                "termsUrl": "https://t",
            }
        )

        self.assertEqual(
            (p.mode, p.budget, p.data_url, p.terms_url),
            ("protected", 1200, "https://d", "https://t"),
        )
        self.assertTrue(p.meters and p.withholds)

    @override_settings(ACCESS_DEFAULT_BUDGET=777)
    def test_no_or_bad_budget_falls_back_to_the_default(self) -> None:
        for budget in (None, "lots"):
            policy.clear_cache()
            self.assertEqual(
                self._policy({"mode": "protected", "detailBudget": budget}).budget, 777
            )

    def test_observe_meters_but_never_withholds(self) -> None:
        p = self._policy({"mode": "observe"})

        self.assertTrue(p.meters)
        self.assertFalse(p.withholds)

    def test_an_unknown_mode_is_open_not_an_error(self) -> None:
        self.assertEqual(self._policy({"mode": "lockdown"}).mode, AccessMode.OPEN)

    @override_settings(ACCESS_MODE_OVERRIDE="protected")
    def test_the_environment_can_override_the_mode(self) -> None:
        self.assertEqual(self._policy({"mode": "open"}).mode, AccessMode.PROTECTED)

    def test_policies_are_cached(self) -> None:
        with patch("access.policy.published_config", return_value={}) as load:
            policy.policy_for("x")
            policy.policy_for("x")

        load.assert_called_once()
