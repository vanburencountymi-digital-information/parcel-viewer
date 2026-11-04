"""Rate limits keyed like the FastAPI backend's (DIC-496, DIC-1852).

Every limit, the data-access meter and the access log key on `client_ip` (DIC-2554).
Counters live in Django's cache: per process, reset on restart, as the FastAPI limiter's
in-memory counters were.
"""

import re
from typing import TYPE_CHECKING

from django.conf import settings
from django.http import HttpRequest
from rest_framework.request import Request
from rest_framework.throttling import (
    AnonRateThrottle,
    ScopedRateThrottle,
    SimpleRateThrottle,
    UserRateThrottle,
)

from common.validation import HttpError

if TYPE_CHECKING:
    # Only for annotations: DRF imports this module (DEFAULT_THROTTLE_CLASSES) while
    # rest_framework.views is still loading.
    from rest_framework.views import APIView

# A DRF/slowapi rate such as "45/minute" or "5/hour", as limits writes it ("45 per 1 minute").
_RATE = re.compile(r"^\s*(\d+)\s*/\s*([a-z]+)\s*$", re.IGNORECASE)
_UNITS = {"s": "second", "m": "minute", "h": "hour", "d": "day"}


def client_ip(request: Request | HttpRequest) -> str:
    """
    Takes a request. Returns the client's address, by PV_TRUSTED_PROXY_HOPS (ADR 0018):
      0 (the VM): X-Real-IP, which our nginx sets and nothing else can reach the API to
        forge, else the socket peer;
      N (Cloud Run): the Nth address from the right of X-Forwarded-For. Each trusted proxy
        appends the address it saw, so entries further left are whatever the client sent.
        X-Real-IP is ignored: Google's front end passes it through from the client.
    A shorter X-Forwarded-For gives its leftmost entry, as DRF's NUM_PROXIES does.
    """
    peer = str(request.META.get("REMOTE_ADDR", ""))
    hops = int(settings.TRUSTED_PROXY_HOPS)
    if hops <= 0:
        return request.headers.get("X-Real-IP") or peer
    chain = [a.strip() for a in request.headers.get("X-Forwarded-For", "").split(",")]
    chain = [a for a in chain if a]
    return chain[-min(hops, len(chain))] if chain else peer


def describe_rate(rate: str) -> str:
    """Takes a rate like "5/hour". Returns it as slowapi showed it in a 429: "5 per 1 hour"."""
    match = _RATE.match(rate or "")
    if not match:
        return rate
    return f"{match.group(1)} per 1 {_UNITS.get(match.group(2)[0].lower(), match.group(2))}"


# DRF's own throttles, keyed on the client address as above. Their default key is the
# whole X-Forwarded-For header when one is sent, which a client can set to anything.
class ClientScopedThrottle(ScopedRateThrottle):
    def get_ident(self, request: Request) -> str:
        return client_ip(request)


class ClientAnonRateThrottle(AnonRateThrottle):
    def get_ident(self, request: Request) -> str:
        return client_ip(request)


class ClientUserRateThrottle(UserRateThrottle):
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

    def get_cache_key(self, request: Request, view: "APIView") -> str:
        ident = "global" if self.shared else client_ip(request)
        return self.cache_format % {"scope": self.scope, "ident": ident}


def check_limits(request: Request, view: "APIView", limits: list[FixedRateThrottle]) -> None:
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
