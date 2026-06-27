"""kb_resolver.py — KB-backed Citation Renderer resolver (DIC-522 / §6.4).

Turns a §6.4 citation envelope { source_id, anchor, span } into a render-ready document by
reading through the KnowledgeStore (A6 seam), so the PV "Sources" panel can surface FULL
section text + a precise passage highlight ("anything in the KB") instead of the one-line
curated-statute stub. The engine's source-agnostic state machine (engine/citation.js,
`resolveCitation`) computes resolves/coarse/none from `anchorResolved`; this module only
locates the document and decides whether the anchor pinned a precise section.

Resolution strategy (precise → coarse → none):
  1. anchor (the MCL / section id the emitter pinned) → store.get_section(anchor).
     A hit means the anchor located that exact section ⇒ anchorResolved = True ⇒ 'resolves'.
  2. else search(span | source_id) → the best section ⇒ matched by similarity, not a
     precise anchor ⇒ anchorResolved = False ⇒ 'coarse'.
  3. nothing citable ⇒ None ⇒ the engine renders 'none' (an uncitable claim is not a fact).

The store is INJECTED, so the harness exercises the resolution logic with a fake store —
no live DB, no OpenAI, no Drake. `build_kb_store()` wires the default (a local JSON fixture
so this is live-verifiable today); set KB_BACKEND=dice to read the converged db-dice
knowledge.chunks once that live-smoke is unblocked.
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import Optional

from kb_store import KnowledgeStore, build_fixture_store, build_store


def _find_passage(body: str, needle: Optional[str]) -> Optional[dict]:
    """Locate `needle` (a key passage) inside `body`, returning {start, end, text} character
    offsets so the viewer can mark exactly that span. Tries an exact match, then a
    whitespace-insensitive match. Returns None if not locatable (the section still resolves;
    the highlight is just an enrichment)."""
    if not body or not needle:
        return None
    idx = body.find(needle)
    if idx >= 0:
        return {"start": idx, "end": idx + len(needle), "text": needle}
    # Whitespace-insensitive fallback: collapse runs of whitespace and re-find.
    import re

    norm = re.sub(r"\s+", " ", needle).strip()
    if norm and norm != needle:
        idx = re.sub(r"\s+", " ", body).find(norm)
        # Offsets into the normalized string don't map back cleanly; only mark when the
        # collapsed body still contains it AND the raw body does too (best-effort exact).
        raw = body.find(norm)
        if raw >= 0:
            return {"start": raw, "end": raw + len(norm), "text": norm}
    return None


def resolve_envelope(store: KnowledgeStore, envelope: dict, domain: Optional[str] = None) -> Optional[dict]:
    """Resolve one §6.4 envelope against `store` → a doc dict the engine resolver consumes:
        { id, title, citation, body, url, anchorResolved, highlight? }  | None
    """
    env = envelope if isinstance(envelope, dict) else {}
    anchor = (env.get("anchor") or "").strip()
    source_id = (env.get("source_id") or "").strip()
    span = (env.get("span") or "").strip()

    section = None
    anchor_resolved = False

    # 1) Precise: the anchor pins an exact section.
    if anchor:
        section = store.get_section(anchor)
        if section:
            anchor_resolved = True

    # 2) Coarse: fall back to a search over the span / citation text.
    if not section:
        query = span or source_id
        if query:
            hits = store.search(query, domain=domain, limit=1)
            if hits:
                # Re-read the full section (search results are snippeted).
                sid = hits[0].get("section_id")
                section = store.get_section(sid) if sid else hits[0]

    # 3) Nothing citable.
    if not section:
        return None

    body = section.get("text") or ""
    # Highlight: prefer an explicit passage hint on the envelope, else the section's own
    # curated highlight, else the span text (the statute name often appears in the body).
    needle = env.get("highlight_text") or section.get("highlight") or span
    highlight = _find_passage(body, needle)

    doc = {
        "id": section.get("section_id") or anchor or source_id,
        "title": section.get("section_title"),
        "citation": section.get("source_name") or source_id,
        "body": body,
        "url": section.get("url") or env.get("url"),
        "anchorResolved": anchor_resolved,
        # Declare our confidence so the engine's conservative ceiling (engine/citation.js
        # floors computed state against `doc.state`, defaulting to 'coarse' when absent)
        # doesn't demote a precise anchor hit. A pinned exact section = 'resolves'.
        "state": "resolves" if anchor_resolved else "coarse",
    }
    if highlight:
        doc["highlight"] = highlight
    return doc


# ── Store wiring ──────────────────────────────────────────────────────────────
_DEFAULT_FIXTURE = Path(__file__).parent / "data" / "mi-tax-statutes-kb.json"


def build_kb_store(jurisdiction: Optional[str] = None) -> KnowledgeStore:
    """Construct the KnowledgeStore the resolver reads through, selected by KB_BACKEND:
      - 'fixture' (default): a local JSON corpus — live-verifiable WITHOUT db-dice/Drake.
      - 'dice'             : the converged db-dice knowledge.chunks (jurisdiction-scoped).
                             GATED on the dice live-smoke; needs psycopg + KB_DATABASE_URL.
    Jurisdiction defaults to the PV canonical tenant ('vanburen', engine/tenant.js)."""
    backend = os.environ.get("KB_BACKEND", "fixture")
    juris = jurisdiction or os.environ.get("KB_JURISDICTION", "vanburen")

    if backend == "fixture":
        path = os.environ.get("KB_FIXTURE", str(_DEFAULT_FIXTURE))
        return build_fixture_store(path, jurisdiction=juris)

    # dice (gated): a real connection pool is required. Imported lazily so the fixture
    # path never depends on psycopg being installed in this image.
    import psycopg
    from psycopg_pool import ConnectionPool

    dsn = os.environ["KB_DATABASE_URL"]
    pool = ConnectionPool(dsn, min_size=0, max_size=2, open=True)

    def acquire():
        return pool.getconn()

    def release(conn):
        pool.putconn(conn)

    return build_store("dice", acquire=acquire, release=release, jurisdiction=juris)
