"""Service-layer logic shared across apps."""

import logging
from collections.abc import Callable, Iterable
from dataclasses import dataclass

from django.conf import settings
from django.db import DatabaseError, connections

from common.enums import DatabaseAlias

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class HealthReport:
    ok: bool


def ping_database(alias: str) -> bool:
    """Takes a database alias. Returns True if it answers a trivial query."""
    try:
        with connections[alias].cursor() as cursor:
            cursor.execute("SELECT 1")
        return True
    except DatabaseError:
        log.warning("health check: database %s unreachable", alias)
        return False


def _api_source_ping() -> bool:
    from parcels.sources import get_parcel_source

    return get_parcel_source().ping()


class HealthService:
    """Liveness and readiness: healthy only when the parcel source answers. With
    PV_PARCEL_SOURCE=sql that's the parcel database; with `api`, parcel-data-api (DIC-2802)."""

    def __init__(
        self,
        ping: Callable[[str], bool] = ping_database,
        aliases: Iterable[str] = (DatabaseAlias.PARCELS,),
        source_ping: Callable[[], bool] = _api_source_ping,
    ) -> None:
        """Takes a ping function and the aliases to check, and the API source's ping
        (all injected for tests)."""
        self._ping = ping
        self._aliases = tuple(aliases)
        self._source_ping = source_ping

    def check(self) -> HealthReport:
        """Returns a report that is ok only if the parcel source answers."""
        if settings.PARCEL_SOURCE == "api":
            return HealthReport(ok=self._source_ping())
        return HealthReport(ok=all(self._ping(alias) for alias in self._aliases))
