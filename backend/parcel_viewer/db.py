"""PostgreSQL connection pool (psycopg3)."""

from psycopg_pool import ConnectionPool
from psycopg.rows import dict_row

from .config import DATABASE_URL

pool = ConnectionPool(
    DATABASE_URL,
    min_size=1,
    max_size=10,
    kwargs={"row_factory": dict_row},
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
