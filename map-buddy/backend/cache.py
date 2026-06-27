"""cache.py — result caching for AI capabilities (C3 / DIC-584).

"The same parcel explained twice shouldn't pay twice." AI capability results are cached
keyed on (capability + tenant + typed input), so an identical request returns the stored
structured output instead of paying for another model call. This builds ON the existing
slowapi rate limiter (it does not replace it) — caching cuts cost, the limiter caps rate.

TENANT-SCOPED (ties to C1 / DIC-582): the key includes the tenant so one county's cached
result can never be served to another. The typed input already differs per tenant's data,
but keying on tenant explicitly makes cross-tenant reuse impossible by construction.

In-process bounded TTL cache — the groundwork. A shared/Redis cache across instances is a
later step; the get/set interface here is the seam for that swap. The clock is injectable
so TTL expiry is testable without sleeping.
"""
import hashlib
import json
import os
import time
from collections import OrderedDict


def cache_key(capability: str, tenant, typed_input) -> str:
    """Stable hash of (capability, tenant, typed input). Order-independent (sorted keys)."""
    payload = json.dumps(
        {"cap": capability, "tenant": tenant or "default", "in": typed_input},
        sort_keys=True, default=str,
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


class ResultCache:
    def __init__(self, max_size: int = 256, ttl_seconds: int = 3600, clock=time.monotonic):
        self.max_size = max_size
        self.ttl = ttl_seconds
        self._clock = clock
        self._store = OrderedDict()  # key -> (expires_at, value)

    def get(self, key):
        item = self._store.get(key)
        if item is None:
            return None
        expires_at, value = item
        if self.ttl and self._clock() >= expires_at:
            del self._store[key]
            return None
        self._store.move_to_end(key)  # LRU: most-recently used to the end
        return value

    def set(self, key, value):
        if key in self._store:
            self._store.move_to_end(key)
        self._store[key] = (self._clock() + self.ttl if self.ttl else float("inf"), value)
        while len(self._store) > self.max_size:
            self._store.popitem(last=False)  # evict least-recently used

    def clear(self):
        self._store.clear()

    def __len__(self):
        return len(self._store)


def _truthy(v):
    return str(v).lower() not in ("0", "false", "no", "off", "")


# Module singleton, toggleable + tunable via env (groundwork for per-tenant/plan config).
_ENABLED = _truthy(os.getenv("AI_RESULT_CACHE", "1"))
_cache = ResultCache(
    max_size=int(os.getenv("AI_CACHE_MAX", "256")),
    ttl_seconds=int(os.getenv("AI_CACHE_TTL", "3600")),
)


def enabled() -> bool:
    return _ENABLED


def get_cache() -> ResultCache:
    return _cache
