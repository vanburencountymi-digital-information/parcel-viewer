"""run_kb_resolver_test.py — KB-backed Citation Renderer resolver (DIC-522 / §6.4) coverage.

Proves the resolver that turns a §6.4 citation envelope into a render-ready KB document
behaves honestly, WITHOUT a live DB / OpenAI / Drake:

  - anchor pins an exact section ⇒ anchorResolved True  (engine floors this to 'resolves').
  - no anchor, search finds a section ⇒ anchorResolved False (engine → 'coarse').
  - nothing citable ⇒ None (engine → 'none'; an uncitable claim is not a fact).
  - the curated MI tax-statute fixture loads + resolves, and the FixtureKnowledgeStore is
    jurisdiction fail-closed (C1 / DIC-582) — a missing tenant is a hard error, never a
    silent cross-tenant read.

Zero-dependency: kb_resolver / knowledge_store import no DB/OpenAI module at load.
"""
import sys
import unittest
from pathlib import Path

# kb_resolver.py + the vendored knowledge_store.py live in the PV map-buddy backend.
MB_BACKEND = Path(__file__).resolve().parents[2] / "map-buddy" / "backend"
sys.path.insert(0, str(MB_BACKEND))

import kb_resolver  # noqa: E402
from kb_store import FixtureKnowledgeStore, build_fixture_store  # noqa: E402

FIXTURE = MB_BACKEND / "data" / "mi-tax-statutes-kb.json"


class FakeStore:
    """Minimal KnowledgeStore: get_section by id, search by substring over title/text."""

    def __init__(self, rows):
        self.rows = {r["section_id"]: r for r in rows}

    def get_section(self, section_id):
        return self.rows.get((section_id or "").strip())

    def search(self, query, domain=None, limit=10):
        q = (query or "").lower()
        hits = [r for r in self.rows.values()
                if q and (q in (r.get("section_title") or "").lower() or q in (r.get("text") or "").lower())]
        return [{"section_id": r["section_id"]} for r in hits[:limit]]


ROW_27A = {
    "section_id": "211.27a",
    "section_title": "Taxable Value & Proposal A",
    "source_name": "MCL 211.27a",
    "text": "Assessed Value is half of True Cash Value. The taxable value rises by the lesser of 5% or inflation until transfer.",
    "url": "http://example/mcl-211-27a",
    "highlight": "the lesser of 5% or inflation",
}


class KbResolverTest(unittest.TestCase):
    def test_anchor_hit_is_precise(self):
        store = FakeStore([ROW_27A])
        doc = kb_resolver.resolve_envelope(store, {"anchor": "211.27a", "source_id": "MCL 211.27a", "span": "Taxable Value cap"})
        self.assertIsNotNone(doc)
        self.assertTrue(doc["anchorResolved"])              # precise → engine 'resolves'
        self.assertEqual(doc["id"], "211.27a")
        self.assertEqual(doc["citation"], "MCL 211.27a")
        self.assertIn("True Cash Value", doc["body"])        # FULL text, not a one-liner
        self.assertEqual(doc["url"], "http://example/mcl-211-27a")

    def test_anchor_hit_locates_passage(self):
        store = FakeStore([ROW_27A])
        doc = kb_resolver.resolve_envelope(store, {"anchor": "211.27a", "span": "x"})
        hl = doc.get("highlight")
        self.assertIsNotNone(hl)
        # Offsets index into the SAME body string the viewer marks.
        self.assertEqual(doc["body"][hl["start"]:hl["end"]], "the lesser of 5% or inflation")

    def test_search_fallback_is_coarse(self):
        store = FakeStore([ROW_27A])
        # No anchor match → search by span; matched by similarity, not a precise anchor.
        doc = kb_resolver.resolve_envelope(store, {"anchor": "999.999", "span": "Proposal A"})
        self.assertIsNotNone(doc)
        self.assertFalse(doc["anchorResolved"])             # → engine 'coarse'

    def test_nothing_citable_returns_none(self):
        store = FakeStore([ROW_27A])
        doc = kb_resolver.resolve_envelope(store, {"anchor": "nope", "span": "no such thing"})
        self.assertIsNone(doc)                               # → engine 'none'

    def test_highlight_text_override_wins(self):
        store = FakeStore([ROW_27A])
        doc = kb_resolver.resolve_envelope(store, {"anchor": "211.27a", "highlight_text": "True Cash Value"})
        hl = doc["highlight"]
        self.assertEqual(doc["body"][hl["start"]:hl["end"]], "True Cash Value")

    # ── Fixture corpus + fail-closed ──────────────────────────────────────────
    def test_fixture_corpus_resolves_full_statute(self):
        store = build_fixture_store(str(FIXTURE), jurisdiction="vanburen")
        # The envelope the explainer actually emits for the PRE statute.
        doc = kb_resolver.resolve_envelope(store, {
            "anchor": "211.7cc", "source_id": "MCL 211.7cc", "span": "Principal Residence Exemption (PRE)",
        })
        self.assertTrue(doc["anchorResolved"])
        self.assertIn("18 mills", doc["body"])
        self.assertIsNotNone(doc.get("highlight"))

    def test_fixture_uncitable_span_does_not_spurious_match(self):
        # A nonsense span must not coarse-match via short noise tokens ("no" in "not").
        store = build_fixture_store(str(FIXTURE), jurisdiction="vanburen")
        self.assertIsNone(kb_resolver.resolve_envelope(store, {"anchor": "zzz", "span": "no such thing"}))

    def test_fixture_is_jurisdiction_scoped(self):
        # A tenant the fixture has no rows for resolves to nothing (fail-closed scoping).
        store = build_fixture_store(str(FIXTURE), jurisdiction="some-other-county")
        self.assertIsNone(kb_resolver.resolve_envelope(store, {"anchor": "211.1"}))

    def test_fixture_missing_jurisdiction_is_hard_error(self):
        with self.assertRaises(ValueError):
            FixtureKnowledgeStore([{"section_id": "x"}], jurisdiction="")


if __name__ == "__main__":
    unittest.main()
