"""Error reporting setup. Kept free of Django imports so settings can call it."""

from collections.abc import Callable
from typing import Any

import sentry_sdk

from common.enums import Environment


def configure_sentry(
    *,
    dsn: str,
    environment: Environment,
    release: str,
    init: Callable[..., Any] | None = None,
) -> bool:
    """
    Takes the Sentry DSN, the current environment, the release string, and optionally an
    init callable (injected so tests don't touch the real SDK).
    Returns True if Sentry was initialised. It is a no-op outside staging and production,
    and when no DSN is set (ADR 0001).
    """
    if not dsn or environment not in Environment.deployed():
        return False

    init_sentry = init or sentry_sdk.init
    init_sentry(
        dsn=dsn,
        environment=str(environment),
        release=release,
        send_default_pii=False,
    )
    return True
