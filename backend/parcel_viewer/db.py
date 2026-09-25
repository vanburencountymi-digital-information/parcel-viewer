"""PostgreSQL connection pool (psycopg3)."""

import os

from psycopg_pool import ConnectionPool
from psycopg.rows import dict_row

from .config import DATABASE_URL

# Guards so one slow query or a saturated pool can't hang a worker (DIC-1853):
# the server cancels any statement past PV_STATEMENT_TIMEOUT_MS, and a request that
# can't get a connection within PV_POOL_TIMEOUT_S fails instead of queueing forever.
STATEMENT_TIMEOUT_MS = int(os.getenv("PV_STATEMENT_TIMEOUT_MS", "10000"))

pool = ConnectionPool(
    DATABASE_URL,
    min_size=1,
    max_size=int(os.getenv("PV_POOL_MAX", "10")),
    timeout=float(os.getenv("PV_POOL_TIMEOUT_S", "10")),
    kwargs={"row_factory": dict_row, "options": f"-c statement_timeout={STATEMENT_TIMEOUT_MS}"},
    open=False,
)


def open_pool() -> None:
    pool.open()


def close_pool() -> None:
    pool.close()


def health_check() -> bool:
    try:
        with pool.connection() as conn:
            conn.execute("SELECT 1")
        return True
    except Exception:
        return False
