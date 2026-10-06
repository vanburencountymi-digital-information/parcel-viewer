"""Service-layer logic shared across apps."""

import logging
from collections.abc import Callable, Iterable
from dataclasses import dataclass

from django.db import DatabaseError, connections

from common.enums import DatabaseAlias

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class HealthReport:
    ok: bool


def _ping(alias: str) -> bool:
    """Takes a database alias. Returns True if it answers a trivial query."""
    try:
        with connections[alias].cursor() as cursor:
            cursor.execute("SELECT 1")
        return True
    except DatabaseError:
        log.warning("health check: database %s unreachable", alias)
        return False


class HealthService:
    """Liveness and readiness: healthy only when the parcel database answers."""

    def __init__(
        self,
        ping: Callable[[str], bool] = _ping,
        aliases: Iterable[str] = (DatabaseAlias.PARCELS,),
    ) -> None:
        """Takes a ping function and the aliases to check (injected for tests)."""
        self._ping = ping
        self._aliases = tuple(aliases)

    def check(self) -> HealthReport:
        """Returns a report that is ok only if every checked database answers."""
        return HealthReport(ok=all(self._ping(alias) for alias in self._aliases))
