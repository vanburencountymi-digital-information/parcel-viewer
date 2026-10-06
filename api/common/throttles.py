"""Rate limits keyed like the FastAPI backend's (DIC-496, DIC-1852).

Behind nginx the real client arrives as X-Real-IP (nginx sets it on /api/); without it,
the socket peer. Counters live in Django's cache: per process, reset on restart, as the
FastAPI limiter's in-memory counters were.
"""

import re

from rest_framework.request import Request
from rest_framework.throttling import ScopedRateThrottle, SimpleRateThrottle
from rest_framework.views import APIView

from common.validation import HttpError

# A DRF/slowapi rate such as "45/minute" or "5/hour", as limits writes it ("45 per 1 minute").
_RATE = re.compile(r"^\s*(\d+)\s*/\s*([a-z]+)\s*$", re.IGNORECASE)
_UNITS = {"s": "second", "m": "minute", "h": "hour", "d": "day"}


def client_ip(request: Request) -> str:
    """Takes a request. Returns the client's address: X-Real-IP behind nginx, else the socket peer."""
    return request.headers.get("X-Real-IP") or str(request.META.get("REMOTE_ADDR", ""))


def describe_rate(rate: str) -> str:
    """Takes a rate like "5/hour". Returns it as slowapi showed it in a 429: "5 per 1 hour"."""
    match = _RATE.match(rate or "")
    if not match:
        return rate
    return f"{match.group(1)} per 1 {_UNITS.get(match.group(2)[0].lower(), match.group(2))}"


class ClientScopedThrottle(ScopedRateThrottle):
    """DRF's scoped throttle, keyed on the client address as above."""

    def get_ident(self, request: Request) -> str:
        return client_ip(request)


class FixedRateThrottle(SimpleRateThrottle):
    """A throttle with its rate given directly; keyed per client, or one bucket for everyone."""

    def __init__(self, name: str, rate: str, *, shared: bool = False) -> None:
        self.scope = name
        self.limit_rate = rate
        self.rate = rate
        self.shared = shared
        self.num_requests, self.duration = self.parse_rate(rate)
        super().__init__()

    def get_rate(self) -> str:
        return self.limit_rate

    def get_cache_key(self, request: Request, view: APIView) -> str:
        ident = "global" if self.shared else client_ip(request)
        return self.cache_format % {"scope": self.scope, "ident": ident}


def check_limits(request: Request, view: APIView, limits: list[FixedRateThrottle]) -> None:
    """
    Takes the request, the view and its limits, per-client first. Raises the FastAPI
    backend's 429 at the first limit exceeded. Called after validation, as slowapi's
    decorators ran: an invalid request doesn't use up the limit, and a request the
    per-client limit rejects never reaches (or spends) the global one.
    """
    for limit in limits:
        if not limit.allow_request(request, view):
            raise HttpError(429, f"Rate limit exceeded: {describe_rate(limit.limit_rate)}")


def limits_for(
    name: str, client_rate: str, global_rate: str | None = None
) -> list[FixedRateThrottle]:
    """Takes a name and rates. Returns the per-client limit, then the shared one if any."""
    limits = [FixedRateThrottle(name, client_rate)]
    if global_rate:
        limits.append(FixedRateThrottle(f"{name}-global", global_rate, shared=True))
    return limits
