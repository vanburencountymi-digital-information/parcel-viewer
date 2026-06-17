"""Writable config store (DIC-464 / DIC-400 / DIC-466).

Holds the per-county config manifest as **append-only versions** plus a single
working **draft**. Backed by the same Postgres DB through a *separate writer role*
in prod (DSN in ``PV_WRITER_DATABASE_URL``), or a local SQLite file in dev — the
dialect is taken from the DSN scheme, so the store logic can be exercised without
Postgres.

Safety contract:
  * The public read path (``GET /config``) must never hard-depend on this store —
    callers fall back to the baked JSON manifest if it's unset or unreachable.
  * Writes go through the writer role on a dedicated connection, isolated from the
    read-only parcels role.
  * Nothing here stores secrets; the writer credential lives only in the DSN
    (Secret Manager in prod).
"""

from __future__ import annotations

import json
import os
from urllib.parse import urlparse

WRITER_DSN = os.getenv("PV_WRITER_DATABASE_URL", "")


def is_configured() -> bool:
    """True when a writer DSN is set — gates all write features."""
    return bool(WRITER_DSN)


def _dialect(dsn: str) -> str:
    scheme = (urlparse(dsn).scheme or "").lower()
    if scheme.startswith("sqlite"):
        return "sqlite"
    if scheme.startswith("postgres"):
        return "postgres"
    raise ValueError(f"unsupported writer DSN scheme: {scheme!r}")


def _sqlite_path(dsn: str) -> str:
    # sqlite:///rel/path.db  or  sqlite:////abs/path.db  or  sqlite:///:memory:
    path = urlparse(dsn).path or ""
    if path.startswith("/"):
        path = path[1:]
    return path or ":memory:"


class ConfigStore:
    """Append-only, draft-aware config store. One row per (county, version);
    drafts are the single row with status='draft' and version NULL."""

    def __init__(self, dsn: str | None = None):
        self.dsn = dsn if dsn is not None else WRITER_DSN
        if not self.dsn:
            raise RuntimeError("ConfigStore requires a DSN (PV_WRITER_DATABASE_URL)")
        self.dialect = _dialect(self.dsn)
        # Postgres lives in a dedicated schema; SQLite has no schema namespace.
        self.table = "config.config_versions" if self.dialect == "postgres" else "config_versions"

    # ── connection / dialect plumbing ───────────────────────────────────────
    def _connect(self):
        if self.dialect == "sqlite":
            import sqlite3
            return sqlite3.connect(_sqlite_path(self.dsn))
        import psycopg  # prod
        return psycopg.connect(self.dsn)

    def _q(self, sql: str) -> str:
        # Author SQL with '?' placeholders; psycopg wants '%s'.
        return sql if self.dialect == "sqlite" else sql.replace("?", "%s")

    # ── schema ──────────────────────────────────────────────────────────────
    def init_schema(self) -> None:
        """Create the versions table if absent. Idempotent. In prod the schema,
        role, and grants come from the migration; this just ensures the table."""
        if self.dialect == "sqlite":
            ddl = (
                "CREATE TABLE IF NOT EXISTS config_versions ("
                " id INTEGER PRIMARY KEY AUTOINCREMENT,"
                " county TEXT NOT NULL,"
                " status TEXT NOT NULL,"
                " version INTEGER,"
                " payload TEXT NOT NULL,"
                " note TEXT,"
                " created_by TEXT,"
                " created_at TEXT NOT NULL DEFAULT (datetime('now')))"
            )
        else:
            ddl = (
                "CREATE TABLE IF NOT EXISTS config.config_versions ("
                " id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,"
                " county TEXT NOT NULL,"
                " status TEXT NOT NULL,"
                " version INTEGER,"
                " payload JSONB NOT NULL,"
                " note TEXT,"
                " created_by TEXT,"
                " created_at TIMESTAMPTZ NOT NULL DEFAULT now())"
            )
        conn = self._connect()
        try:
            conn.execute(self._q(ddl))
            conn.commit()
        finally:
            conn.close()

    # ── payload (de)serialization (JSONB on PG accepts a JSON string param) ──
    def _dump(self, payload: dict) -> str:
        return json.dumps(payload, ensure_ascii=False)

    def _load(self, raw) -> dict:
        return raw if isinstance(raw, (dict, list)) else json.loads(raw)

    # ── reads ────────────────────────────────────────────────────────────────
    def get_published(self, county: str) -> dict | None:
        sql = (f"SELECT payload FROM {self.table} WHERE county=? AND status='published'"
               " ORDER BY version DESC LIMIT 1")
        conn = self._connect()
        try:
            row = conn.execute(self._q(sql), (county,)).fetchone()
            return self._load(row[0]) if row else None
        finally:
            conn.close()

    def get_draft(self, county: str) -> dict | None:
        """The working draft, or the latest published if no draft exists yet."""
        sql = f"SELECT payload FROM {self.table} WHERE county=? AND status='draft' LIMIT 1"
        conn = self._connect()
        try:
            row = conn.execute(self._q(sql), (county,)).fetchone()
            if row:
                return self._load(row[0])
        finally:
            conn.close()
        return self.get_published(county)

    def list_versions(self, county: str) -> list[dict]:
        sql = (f"SELECT version, note, created_by, created_at FROM {self.table}"
               " WHERE county=? AND status='published' ORDER BY version DESC")
        conn = self._connect()
        try:
            rows = conn.execute(self._q(sql), (county,)).fetchall()
            return [{"version": r[0], "note": r[1], "created_by": r[2],
                     "created_at": str(r[3])} for r in rows]
        finally:
            conn.close()

    # ── writes ───────────────────────────────────────────────────────────────
    def save_draft(self, county: str, payload: dict, author: str | None = None) -> None:
        """Replace the single working draft for this county."""
        conn = self._connect()
        try:
            conn.execute(self._q(f"DELETE FROM {self.table} WHERE county=? AND status='draft'"), (county,))
            conn.execute(
                self._q(f"INSERT INTO {self.table} (county, status, version, payload, created_by)"
                        " VALUES (?, 'draft', NULL, ?, ?)"),
                (county, self._dump(payload), author),
            )
            conn.commit()
        finally:
            conn.close()

    def _next_version(self, conn, county: str) -> int:
        sql = f"SELECT COALESCE(MAX(version), 0) FROM {self.table} WHERE county=? AND status='published'"
        return int(conn.execute(self._q(sql), (county,)).fetchone()[0]) + 1

    def publish(self, county: str, author: str | None = None, note: str | None = None) -> int:
        """Promote the current draft to a new published version. Returns the version."""
        draft = self.get_draft(county)
        if draft is None:
            raise ValueError(f"no draft to publish for county {county!r}")
        conn = self._connect()
        try:
            version = self._next_version(conn, county)
            conn.execute(
                self._q(f"INSERT INTO {self.table} (county, status, version, payload, note, created_by)"
                        " VALUES (?, 'published', ?, ?, ?, ?)"),
                (county, version, self._dump(draft), note or "Published", author),
            )
            conn.commit()
            return version
        finally:
            conn.close()

    def rollback(self, county: str, version: int, author: str | None = None) -> int:
        """Restore a prior version by publishing a copy of it as the new latest
        version (append-only — history is never rewritten). Returns the new version."""
        sql = f"SELECT payload FROM {self.table} WHERE county=? AND status='published' AND version=? LIMIT 1"
        conn = self._connect()
        try:
            row = conn.execute(self._q(sql), (county, version)).fetchone()
            if not row:
                raise ValueError(f"version {version} not found for county {county!r}")
            payload = self._load(row[0])
            new_version = self._next_version(conn, county)
            conn.execute(
                self._q(f"INSERT INTO {self.table} (county, status, version, payload, note, created_by)"
                        " VALUES (?, 'published', ?, ?, ?, ?)"),
                (county, new_version, self._dump(payload), f"Rollback to v{version}", author),
            )
            conn.commit()
            return new_version
        finally:
            conn.close()

    def seed_if_empty(self, county: str, payload: dict) -> bool:
        """Initialize a county from the baked manifest on first use. Returns True
        if it seeded (no published version existed)."""
        if self.get_published(county) is not None:
            return False
        conn = self._connect()
        try:
            conn.execute(
                self._q(f"INSERT INTO {self.table} (county, status, version, payload, note, created_by)"
                        " VALUES (?, 'published', 1, ?, 'Seeded from baked manifest', 'system')"),
                (county, self._dump(payload)),
            )
            conn.commit()
            return True
        finally:
            conn.close()
