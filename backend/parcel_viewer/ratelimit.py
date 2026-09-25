"""Shared slowapi limiter (DIC-496, DIC-1852).

Lives outside app.main so routers can decorate endpoints without a circular import.
Counters are in-process memory: per worker, reset on restart. That is enough to stop
casual flooding of a single instance; a shared store is a later hardening step.
"""

from fastapi import Request
from slowapi import Limiter
from slowapi.util import get_remote_address


# Behind nginx the real client IP arrives as X-Real-IP (proxy_set_header is set on
# /api/); fall back to the socket peer for direct/local requests.
def client_ip(request: Request) -> str:
    return request.headers.get("X-Real-IP") or get_remote_address(request)


def global_key() -> str:
    """One bucket shared by every caller — a hard ceiling that IP rotation can't dodge."""
    return "global"


limiter = Limiter(key_func=client_ip)
