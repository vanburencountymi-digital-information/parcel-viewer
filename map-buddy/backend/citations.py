"""citations.py — extract §6.4 citation envelopes from AI prose (DIC-522).

Map Buddy's chat answers cite Michigan statutes inline (e.g. "(MCL 211.27a)"). This turns
those mentions into the SAME §6.4 envelope the explainer emits — { source_id, anchor, span }
— so the viewer's delegated `[data-cite-source]` handler surfaces them into the ONE Sources
panel (now KB-backed), giving full 3-way sync: AI answer ↔ cited source ↔ map.

Citation-first discipline (§4.5): only statutes in the vetted KB corpus
(data/mi-tax-statutes-kb.json — the same list the model is told to cite from, and the same
the KB resolver resolves) become clickable citations. A hallucinated MCL the model invents
is NOT surfaced as a "source", so a clickable citation can never out-run its grounding.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

_CORPUS = Path(__file__).parent / "data" / "mi-tax-statutes-kb.json"

# An MCL reference as the model writes it: "MCL 211.27a", "MCL 211.27a(2)", "MCL 205.731".
# The base section (211.27a) is the KB anchor; trailing subsection "(2)" is dropped so it
# resolves to the section the corpus holds.
_MCL_RE = re.compile(r"MCL\s*(\d{2,3}\.\d+[a-z]*)", re.IGNORECASE)


def _load_index() -> dict:
    """Map base MCL → §6.4 envelope, from the vetted corpus. Built once at import."""
    try:
        data = json.loads(_CORPUS.read_text(encoding="utf-8"))
    except Exception:
        return {}
    idx = {}
    for c in data.get("chunks", []):
        mcl = (c.get("section_id") or "").strip().lower()
        if mcl:
            idx[mcl] = {
                "source_id": c.get("source_name") or ("MCL " + mcl),
                "anchor": mcl,
                "span": c.get("section_title"),
            }
    return idx


_BY_MCL = _load_index()


def extract_citations(text: str) -> list[dict]:
    """De-duplicated §6.4 envelopes for vetted MCLs mentioned in `text`, in
    first-appearance order. Unknown/invented MCLs are ignored (citation-first)."""
    if not text:
        return []
    seen: set[str] = set()
    out: list[dict] = []
    for m in _MCL_RE.finditer(text):
        mcl = m.group(1).lower()
        env = _BY_MCL.get(mcl)
        if env and mcl not in seen:
            seen.add(mcl)
            out.append(dict(env))
    return out
