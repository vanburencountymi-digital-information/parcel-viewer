"""usage.py — per-tenant AI usage metering + quotas (C3 / DIC-584).

Public viewers + AI = unbounded spend unless governed. Each tenant gets an AI-call budget
over a rolling window; when it's exhausted the AI routes DEGRADE TO AI-OFF (the viewer
already falls back to facts via B4/DIC-580) rather than erroring or billing unboundedly.

Quotas are CONFIG-DRIVEN per tenant/plan (default + overrides), not hardcoded — the
groundwork for tiered/paid plans (a paid tier unlocks a higher limit). Cache hits do NOT
consume quota (they cost nothing), so metering happens only on real model calls.

In-process rolling-window counter — the groundwork. The seam (count/record) is where
DIC-400's shared usage counters swap in for multi-instance; the policy here is unchanged.
The clock is injectable so window/quota behavior is testable without sleeping.
"""
import os
import time
from collections import defaultdict, deque


class UsageCounter:
    """Rolling-window per-tenant call counter."""

    def __init__(self, window_seconds: int = 3600, clock=time.monotonic):
        self.window = window_seconds
        self._clock = clock
        self._events = defaultdict(deque)  # tenant -> deque[timestamps]

    def _prune(self, tenant, now):
        dq = self._events[tenant]
        cutoff = now - self.window
        while dq and dq[0] <= cutoff:
            dq.popleft()

    def count(self, tenant: str) -> int:
        now = self._clock()
        self._prune(tenant, now)
        return len(self._events[tenant])

    def record(self, tenant: str):
        now = self._clock()
        self._prune(tenant, now)
        self._events[tenant].append(now)

    def reset(self, tenant=None):
        if tenant is None:
            self._events.clear()
        else:
            self._events.pop(tenant, None)


class QuotaConfig:
    """Per-tenant/plan AI-call limits. A falsy limit (0/None) means UNLIMITED."""

    def __init__(self, default_limit=None, overrides=None):
        self.default_limit = default_limit
        self.overrides = overrides or {}  # tenant -> limit

    def limit_for(self, tenant: str):
        return self.overrides.get(tenant, self.default_limit)

    def enabled(self) -> bool:
        return bool(self.default_limit) or any(self.overrides.values())


def check_quota(counter: UsageCounter, quota: QuotaConfig, tenant):
    """Return (allowed, remaining). A falsy limit → unlimited → always allowed."""
    t = tenant or "default"
    limit = quota.limit_for(t)
    if not limit:
        return True, None
    used = counter.count(t)
    return used < limit, max(0, limit - used)


def _parse_overrides(s: str) -> dict:
    """'vbc=1000,sjc=500' -> {'vbc': 1000, 'sjc': 500}."""
    out = {}
    for part in (s or "").split(","):
        if "=" in part:
            k, v = part.split("=", 1)
            try:
                out[k.strip()] = int(v)
            except ValueError:
                pass
    return out


# Module singletons, config-driven via env (groundwork for the DIC-459 per-tenant config).
_counter = UsageCounter(window_seconds=int(os.getenv("AI_QUOTA_WINDOW", "3600")))
_quota = QuotaConfig(
    default_limit=int(os.getenv("AI_QUOTA_DEFAULT", "0")) or None,
    overrides=_parse_overrides(os.getenv("AI_QUOTA_OVERRIDES", "")),
)


def enabled() -> bool:
    return _quota.enabled()


def allow(tenant):
    """(allowed, remaining) for a tenant's next AI call. Always allowed when no quota set."""
    if not enabled():
        return True, None
    return check_quota(_counter, _quota, tenant)


def record(tenant):
    """Count a real (non-cached) AI call against the tenant's quota."""
    if enabled():
        _counter.record(tenant or "default")
