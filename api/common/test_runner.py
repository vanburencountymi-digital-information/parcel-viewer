"""Test runner that closes the connection pools before the test database is dropped."""

from typing import Any

from django.db import connections
from django.test.runner import DiscoverRunner


class PooledTestRunner(DiscoverRunner):
    """
    Every alias keeps a psycopg pool (ADR 0005), and the parcels and config-store aliases
    mirror the default test database. Their idle pooled connections would block
    DROP DATABASE at teardown, so the pools are closed first.
    """

    def teardown_databases(self, old_config: Any, **kwargs: Any) -> None:
        for connection in connections.all(initialized_only=True):
            close_pool = getattr(connection, "close_pool", None)
            if close_pool is not None:
                close_pool()
        super().teardown_databases(old_config, **kwargs)
