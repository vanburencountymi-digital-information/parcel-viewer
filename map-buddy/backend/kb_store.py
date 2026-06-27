"""kb_store.py — KnowledgeStore interface + SQL/Fixture implementations (A6 / DIC-570).

VENDORED COPY of ZIP/zip-poc/backend/knowledge_store.py so the PV map-buddy service can
read the County Knowledge Base through the SAME A6 seam without a cross-repo runtime
import (the two repos deploy as independent Docker images). The SqlKnowledgeStore half is
byte-equivalent to the ZIP original; this copy ADDS a `FixtureKnowledgeStore` so the
KB-backed citation resolver (DIC-522) is live-verifiable WITHOUT db-dice/Drake — the dice
live-smoke stays gated.

NOTE the deliberate module rename (knowledge_store → kb_store): the ISV harness imports BOTH
this copy and ZIP's original in one Python process; identical module names would collide in
sys.modules. A unique name keeps both importable (and is unambiguous in this container).

⚠ SINGLE-SOURCE FOLLOW-UP (A8-style, cf. DIC-575 drawing files): the SqlKnowledgeStore here
duplicates ZIP/zip-poc/backend/knowledge_store.py. Until a shared package extracts it, the
SqlKnowledgeStore portion MUST be kept in sync with the ZIP original. The Fixture half is
PV-only.

Decouples knowledge retrieval from the hardcoded table so the SAME calling code runs against:
  - ZIP-local : public.knowledge_chunks (`text` column), un-scoped.
  - DICE      : knowledge.chunks (`content` column, `jurisdiction`-scoped) — db-dice.
  - fixture   : an in-memory JSON corpus (this file), jurisdiction-scoped — local verify.

Results map to an IDENTICAL shape regardless of backend (facts-parity, §4.6): the content
column is always aliased to `text` in the output dict.

AI is a CALLER, never in the critical path (§4.3): semantic (embedding) search is tried
first for SQL backends, degrading to full-text then ILIKE when the embedder is unavailable.
The connection and embedder are INJECTED, so the harness exercises the SQL, the jurisdiction
scoping, and the result shape with no live DB and no OpenAI dep.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Optional


# ── Schema descriptors (the ONLY thing that differs between the two SQL backends) ──
@dataclass(frozen=True)
class KnowledgeSchema:
    table: str                              # "knowledge_chunks" | "knowledge.chunks"
    content_col: str                        # "text" (ZIP-local) | "content" (DICE)
    jurisdiction_col: Optional[str] = None  # "jurisdiction" on DICE; None = un-scoped


ZIP_LOCAL_SCHEMA = KnowledgeSchema(table="knowledge_chunks", content_col="text")
DICE_SCHEMA = KnowledgeSchema(table="knowledge.chunks", content_col="content", jurisdiction_col="jurisdiction")

_SNIPPET_MAX = 600   # search-result text is truncated to this; full text via get_section


def _default_embedder(query: str) -> Optional[list]:
    """OpenAI text-embedding-3-small (A6-b). Returns None on ANY failure so the caller
    falls back to full-text search — embeddings are never on the critical path."""
    import os

    key = os.environ.get("OPENAI_API_KEY")
    if not key:
        return None
    try:
        from openai import OpenAI

        client = OpenAI(api_key=key, timeout=5.0)
        return client.embeddings.create(model="text-embedding-3-small", input=[query]).data[0].embedding
    except Exception:
        return None


class KnowledgeStore:
    """Interface: jurisdiction-scoped knowledge retrieval. Backends implement these."""

    def search(self, query: str, domain: Optional[str] = None, limit: int = 10) -> list[dict]:
        raise NotImplementedError

    def get_section(self, section_id: str) -> Optional[dict]:
        raise NotImplementedError

    def source_name(self, section_id: str) -> Optional[str]:
        raise NotImplementedError


class SqlKnowledgeStore(KnowledgeStore):
    """One SQL implementation, parameterized by `KnowledgeSchema`. Connection access is
    injected as acquire()/release(conn) (the ZIP pool by default); the embedder is
    injected so the AI path is mockable."""

    def __init__(
        self,
        schema: KnowledgeSchema,
        acquire: Callable[[], object],
        release: Callable[[object], None],
        jurisdiction: Optional[str] = None,
        embedder: Callable[[str], Optional[list]] = _default_embedder,
    ):
        # FAIL CLOSED (C1 / DIC-582): a jurisdiction-scoped backend MUST be given a tenant,
        # else every query runs un-scoped and returns ALL tenants' rows — a cross-tenant
        # leak. Tenant isolation is security, not a feature (§4.13).
        if schema.jurisdiction_col and not jurisdiction:
            raise ValueError(
                "KnowledgeStore: backend '%s' is jurisdiction-scoped but no jurisdiction "
                "was provided (fail-closed; would otherwise leak across tenants)" % schema.table
            )
        self.schema = schema
        self._acquire = acquire
        self._release = release
        self.jurisdiction = jurisdiction if schema.jurisdiction_col else None
        self._embed = embedder

    def _scope(self, *clauses: str) -> tuple[str, list]:
        parts: list[str] = []
        params: list = []
        if self.schema.jurisdiction_col and self.jurisdiction:
            parts.append(f"{self.schema.jurisdiction_col} = %s")
            params.append(self.jurisdiction)
        parts.extend(clauses)
        where = (" WHERE " + " AND ".join(parts)) if parts else ""
        return where, params

    def _map_rows(self, rows: list, method: str) -> list[dict]:
        out = []
        for r in rows:
            text = r[3] or ""
            out.append({
                "section_id": r[0],
                "section_title": r[1],
                "page_number": r[2],
                "text": (text[:_SNIPPET_MAX] + "...") if len(text) > _SNIPPET_MAX else text,
                "source_name": r[4],
                "similarity": round(float(r[5]), 4) if len(r) > 5 and r[5] else 0,
                "search_method": method,
            })
        return out

    def search(self, query: str, domain: Optional[str] = None, limit: int = 10) -> list[dict]:
        t = self.schema.table
        c = self.schema.content_col
        conn = self._acquire()
        try:
            emb = None
            try:
                emb = self._embed(query)
            except Exception:
                emb = None
            if emb is not None:
                emb_str = "[" + ",".join(str(x) for x in emb) + "]"
                extra = ["domain = %s"] if domain else []
                where, pre = self._scope(*extra)
                dparams = [domain] if domain else []
                sql = (
                    f"SELECT section_id, section_title, page_number, {c} AS text, source_name, "
                    f"1 - (embedding <=> %s::vector) AS similarity FROM {t}{where} "
                    f"ORDER BY embedding <=> %s::vector LIMIT %s"
                )
                with conn.cursor() as cur:
                    cur.execute(sql, [emb_str] + pre + dparams + [emb_str, limit])
                    rows = cur.fetchall()
                return self._map_rows(rows, "semantic")

            extra = ["domain = %s"] if domain else []
            extra.append(f"to_tsvector('english', COALESCE({c},'')) @@ plainto_tsquery('english', %s)")
            where, pre = self._scope(*extra)
            dparams = ([domain] if domain else []) + [query]
            sql = (
                f"SELECT section_id, section_title, page_number, {c} AS text, source_name, "
                f"ts_rank(to_tsvector('english', COALESCE({c},'')), plainto_tsquery('english', %s)) AS rank "
                f"FROM {t}{where} ORDER BY rank DESC LIMIT %s"
            )
            with conn.cursor() as cur:
                cur.execute(sql, [query] + pre + dparams + [limit])
                rows = cur.fetchall()

            if not rows:
                tokens = [tok for tok in query.split() if len(tok) >= 4][:4]
                if tokens:
                    title_or = "(" + " OR ".join("section_title ILIKE %s" for _ in tokens) + ")"
                    where, pre = self._scope(title_or)
                    sql = (
                        f"SELECT section_id, section_title, page_number, {c} AS text, source_name, 0 AS rank "
                        f"FROM {t}{where} ORDER BY section_id LIMIT %s"
                    )
                    with conn.cursor() as cur:
                        cur.execute(sql, pre + [f"%{tok}%" for tok in tokens] + [limit])
                        rows = cur.fetchall()

            return self._map_rows(rows, "fulltext")
        finally:
            self._release(conn)

    def get_section(self, section_id: str) -> Optional[dict]:
        t = self.schema.table
        c = self.schema.content_col
        conn = self._acquire()
        try:
            where, pre = self._scope("(section_id = %s OR section_id LIKE %s)")
            sql = (
                f"SELECT section_id, section_title, page_number, {c} AS text, source_name "
                f"FROM {t}{where} ORDER BY section_id"
            )
            with conn.cursor() as cur:
                cur.execute(sql, pre + [section_id, section_id + "-%"])
                rows = cur.fetchall()
            if not rows:
                return None
            return {
                "section_id": section_id,
                "section_title": rows[0][1],
                "page_number": rows[0][2],
                "text": "\n\n".join(r[3] or "" for r in rows),
                "source_name": rows[0][4],
            }
        finally:
            self._release(conn)

    def source_name(self, section_id: str) -> Optional[str]:
        t = self.schema.table
        conn = self._acquire()
        try:
            where, pre = self._scope("section_id = %s")
            with conn.cursor() as cur:
                cur.execute(f"SELECT source_name FROM {t}{where} LIMIT 1", pre + [section_id])
                row = cur.fetchone()
            return row[0] if row else None
        finally:
            self._release(conn)


class FixtureKnowledgeStore(KnowledgeStore):
    """In-memory KnowledgeStore backed by a JSON corpus — lets the KB-backed citation
    resolver (DIC-522) be exercised live WITHOUT db-dice/Drake (the dice live-smoke is
    gated, and VBC's statute corpus is not yet ingested into knowledge.chunks). Same
    interface + jurisdiction fail-closed as the SQL store, so swapping to `dice` later
    changes only the builder, not the resolver.

    Each row: {section_id, section_title, page_number?, text, source_name, domain?,
               url?, highlight?}  (`highlight` = a key passage substring of `text`).
    """

    def __init__(self, chunks: list[dict], jurisdiction: str):
        if not jurisdiction:
            # FAIL CLOSED (C1 / DIC-582): mirror the SQL store — never serve un-scoped.
            raise ValueError(
                "FixtureKnowledgeStore: jurisdiction required (fail-closed; would otherwise "
                "serve every tenant's rows)"
            )
        self.jurisdiction = jurisdiction
        # Scope rows to the jurisdiction. A row without its own jurisdiction is assumed to
        # belong to this store's jurisdiction (single-tenant fixture files).
        self._rows = [c for c in (chunks or []) if (c.get("jurisdiction") or jurisdiction) == jurisdiction]

    def _doc(self, r: dict, snippet: bool = False) -> dict:
        text = r.get("text") or r.get("content") or ""
        if snippet and len(text) > _SNIPPET_MAX:
            text = text[:_SNIPPET_MAX] + "..."
        d = {
            "section_id": r.get("section_id"),
            "section_title": r.get("section_title"),
            "page_number": r.get("page_number"),
            "text": text,
            "source_name": r.get("source_name"),
        }
        if r.get("url"):
            d["url"] = r["url"]
        if r.get("highlight"):
            d["highlight"] = r["highlight"]
        return d

    def search(self, query: str, domain: Optional[str] = None, limit: int = 10) -> list[dict]:
        # Only score on tokens >= 4 chars (mirrors the SqlKnowledgeStore ILIKE last-resort):
        # short noise words like "no"/"of" must not substring-match (e.g. "no" inside "not")
        # and turn an UNcitable claim into a spurious coarse hit.
        toks = [t for t in (query or "").lower().split() if len(t) >= 4]
        scored = []
        for r in self._rows:
            if domain and r.get("domain") != domain:
                continue
            hay = " ".join(
                str(r.get(k) or "") for k in ("section_id", "section_title", "source_name", "text")
            ).lower()
            score = sum(1 for tok in toks if tok in hay)
            if score:
                scored.append((score, r))
        scored.sort(key=lambda sr: -sr[0])
        out = []
        for _score, r in scored[:limit]:
            d = self._doc(r, snippet=True)
            d["similarity"] = 0
            d["search_method"] = "fixture"
            out.append(d)
        return out

    def get_section(self, section_id: str) -> Optional[dict]:
        sid = (section_id or "").strip()
        for r in self._rows:
            if r.get("section_id") == sid:
                return self._doc(r)
        return None

    def source_name(self, section_id: str) -> Optional[str]:
        sec = self.get_section(section_id)
        return sec.get("source_name") if sec else None


def build_store(
    backend: str,
    acquire: Callable[[], object],
    release: Callable[[object], None],
    jurisdiction: Optional[str] = None,
    embedder: Callable[[str], Optional[list]] = _default_embedder,
) -> SqlKnowledgeStore:
    """Construct a SQL store for `backend` ('zip-local' | 'dice'). 'dice' scopes by the
    given jurisdiction key."""
    schema = DICE_SCHEMA if backend == "dice" else ZIP_LOCAL_SCHEMA
    return SqlKnowledgeStore(schema, acquire, release, jurisdiction=jurisdiction, embedder=embedder)


def build_fixture_store(source, jurisdiction: str) -> FixtureKnowledgeStore:
    """Construct a FixtureKnowledgeStore from a JSON file path (or a dict/list already
    loaded). The file shape is {"jurisdiction": "...", "chunks": [...]} or a bare list."""
    if isinstance(source, (str, Path)):
        data = json.loads(Path(source).read_text(encoding="utf-8"))
    else:
        data = source
    if isinstance(data, dict):
        chunks = data.get("chunks") or data.get("rows") or []
        file_juris = data.get("jurisdiction")
        # Stamp the file's declared jurisdiction onto every untagged row, so scoping is REAL
        # (a request for a different tenant returns no rows — fail-closed, C1 / DIC-582).
        if file_juris:
            chunks = [dict(c, jurisdiction=c.get("jurisdiction") or file_juris) for c in chunks]
        jurisdiction = jurisdiction or file_juris
    else:
        chunks = data
    return FixtureKnowledgeStore(chunks, jurisdiction=jurisdiction)
