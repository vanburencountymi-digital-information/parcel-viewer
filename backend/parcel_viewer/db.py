"""PostgreSQL connection pool (psycopg3)."""

import os

from psycopg import Connection
from psycopg.rows import DictRow, dict_row
from psycopg_pool import ConnectionPool

from .config import DATABASE_URL

# Guards so one slow query or a saturated pool can't hang a worker (DIC-1853):
# the server cancels any statement past PV_STATEMENT_TIMEOUT_MS, and a request that
# can't get a connection within PV_POOL_TIMEOUT_S fails instead of queueing forever.
STATEMENT_TIMEOUT_MS = int(os.getenv("PV_STATEMENT_TIMEOUT_MS", "10000"))

# Dead connections (DIC-1872). After a network blip or DB failover, pooled connections
# can be silently dead: a query on one hung until nginx gave up at 60s (reproduced by
# dropping the API's network). TCP keepalives and tcp_user_timeout make the socket fail
# in seconds instead, and check_connection discards a dead connection at checkout so
# the request gets a fresh one. Whatever still fails becomes a 503 (app.main).
CONNECT_TIMEOUT_S = int(os.getenv("PV_DB_CONNECT_TIMEOUT_S", "5"))
TCP_USER_TIMEOUT_MS = int(os.getenv("PV_DB_TCP_USER_TIMEOUT_MS", "10000"))

# Typed with its row type so callers (and mypy) know every row is a dict.
pool: ConnectionPool[Connection[DictRow]] = ConnectionPool(
    DATABASE_URL,
    connection_class=Connection[DictRow],
    min_size=1,
    max_size=int(os.getenv("PV_POOL_MAX", "10")),
    timeout=float(os.getenv("PV_POOL_TIMEOUT_S", "10")),
    check=ConnectionPool.check_connection,
    kwargs={
        "row_factory": dict_row,
        "options": f"-c statement_timeout={STATEMENT_TIMEOUT_MS}",
        "connect_timeout": CONNECT_TIMEOUT_S,
        "keepalives": 1,
        "keepalives_idle": 30,
        "keepalives_interval": 10,
        "keepalives_count": 3,
        "tcp_user_timeout": TCP_USER_TIMEOUT_MS,
        # Names the connections in pg_stat_activity, so the viewer's share of the shared
        # database's connection budget can be counted apart from parcel-studio's, which
        # uses the same role (DIC-1884).
        "application_name": "parcel-viewer-api",
    },
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
