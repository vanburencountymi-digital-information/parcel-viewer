"""Raw-SQL helpers for the repositories (ADR 0006): rows come back as dicts, as in FastAPI."""

import json
from collections.abc import Sequence
from typing import Any

from django.db import connections

# Postgres type OIDs for json and jsonb. Django's backend leaves these as text (its
# JSONField parses them); FastAPI's psycopg parsed them, so raw rows are parsed here.
JSON_TYPE_OIDS = frozenset({114, 3802})


def _row_dicts(cursor: Any) -> list[dict[str, Any]]:
    names = [col.name for col in cursor.description]
    json_columns = {
        col.name for col in cursor.description if getattr(col, "type_code", None) in JSON_TYPE_OIDS
    }
    rows = []
    for values in cursor.fetchall():
        row = dict(zip(names, values, strict=True))
        for name in json_columns:
            if isinstance(row[name], str):
                row[name] = json.loads(row[name])
        rows.append(row)
    return rows


def fetch_all(alias: str, sql: str, params: Sequence[Any] = ()) -> list[dict[str, Any]]:
    """Takes a database alias, SQL with %s placeholders, and its parameters. Returns all rows as dicts."""
    with connections[alias].cursor() as cursor:
        cursor.execute(sql, list(params))
        return _row_dicts(cursor)


def fetch_one(alias: str, sql: str, params: Sequence[Any] = ()) -> dict[str, Any] | None:
    """Takes a database alias, SQL and its parameters. Returns the first row as a dict, or None."""
    rows = fetch_all(alias, sql, params)
    return rows[0] if rows else None
