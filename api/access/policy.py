"""A county's data-access policy, read from its manifest's `access` block (ADR 0015).

    "access": {
      "mode": "open" | "observe" | "protected",   # absent means open
      "detailBudget": 5000,                       # detailed records per client per day
      "dataUrl": "https://…",                     # where to get the full dataset
      "termsUrl": "https://…"                     # terms of use
    }

open: no metering at all (today's behaviour). observe: count and log, never withhold, to
learn a county's real usage before setting a budget. protected: count, and past the budget
send parcels without their owner/value fields.
"""

import time
from dataclasses import dataclass
from enum import StrEnum
from typing import Any

from django.conf import settings
from django.core.signals import setting_changed

from county_config.store import published_config

POLICY_TTL_S = 60.0
_cache: dict[str, tuple[float, "AccessPolicy"]] = {}


class AccessMode(StrEnum):
    OPEN = "open"
    OBSERVE = "observe"
    PROTECTED = "protected"


@dataclass(frozen=True)
class AccessPolicy:
    county: str
    mode: AccessMode
    budget: int
    data_url: str | None = None
    terms_url: str | None = None

    @property
    def meters(self) -> bool:
        """True when requests are counted (observe and protected)."""
        return self.mode != AccessMode.OPEN

    @property
    def withholds(self) -> bool:
        """True when details are withheld past the budget (protected only)."""
        return self.mode == AccessMode.PROTECTED


def _parse(county: str, manifest: dict[str, Any] | None) -> AccessPolicy:
    access = (manifest or {}).get("access") or {}
    override = str(settings.ACCESS_MODE_OVERRIDE or "")
    raw_mode = override or str(access.get("mode") or AccessMode.OPEN)
    try:
        mode = AccessMode(raw_mode)
    except ValueError:
        mode = AccessMode.OPEN
    try:
        budget = int(access.get("detailBudget") or settings.ACCESS_DEFAULT_BUDGET)
    except (TypeError, ValueError):
        budget = int(settings.ACCESS_DEFAULT_BUDGET)
    return AccessPolicy(
        county=county,
        mode=mode,
        budget=max(budget, 0),
        data_url=access.get("dataUrl") or None,
        terms_url=access.get("termsUrl") or None,
    )


def policy_for(county: str | None = None) -> AccessPolicy:
    """Takes a county (the deployment's by default). Returns its policy, cached for a minute."""
    county = county or str(settings.DEFAULT_COUNTY)
    cached = _cache.get(county)
    if cached and time.monotonic() - cached[0] < POLICY_TTL_S:
        return cached[1]
    policy = _parse(county, published_config(county))
    _cache[county] = (time.monotonic(), policy)
    return policy


def clear_cache(**_: Any) -> None:
    """Forgets cached policies (tests, and after a config publish)."""
    _cache.clear()


def _on_setting_changed(setting: str, **kwargs: Any) -> None:
    if setting.startswith("ACCESS_") or setting in {"DEFAULT_COUNTY", "CONFIG_STORE_CONFIGURED"}:
        clear_cache()


setting_changed.connect(_on_setting_changed)
