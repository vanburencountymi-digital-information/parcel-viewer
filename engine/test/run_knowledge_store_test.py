"""run_knowledge_store_test.py — KnowledgeStore seam (A6 / DIC-570) harness coverage.

Proves the ZIP/map-buddy knowledge retrieval is now backend-agnostic, WITHOUT a live
DB or OpenAI key (connection + embedder are injected and faked):

  - DICE backend scopes every query by jurisdiction and reads knowledge.chunks/content;
    ZIP-local reads knowledge_chunks/text and is un-scoped (the A6 decouple).
  - AI is a caller, not the critical path (§4.3): no embedder → full-text → ILIKE.
  - Result shape is IDENTICAL across backends (facts-parity, §4.6): the content column
    is aliased to `text` so callers (agent.py) don't change.

Zero-dependency: knowledge_store.py imports no DB/OpenAI module at load, so this runs
under stock `python -m unittest`.
"""
import sys
import unittest
from pathlib import Path

# knowledge_store.py lives in the ZIP backend (the A6 convergence target).
ZIP_BACKEND = Path(__file__).resolve().parents[3] / "ZIP" / "zip-poc" / "backend"
sys.path.insert(0, str(ZIP_BACKEND))

from knowledge_store import build_store, DICE_SCHEMA, ZIP_LOCAL_SCHEMA  # noqa: E402


class FakeCursor:
    def __init__(self, rows):
        self.rows = rows
        self.executed = []

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def execute(self, sql, params=None):
        self.executed.append((" ".join(sql.split()), list(params) if params else []))

    def fetchall(self):
        return self.rows

    def fetchone(self):
        return self.rows[0] if self.rows else None


class FakeConn:
    """Returns each batch of canned rows on successive cursor() calls (so a query that
    runs FTS-then-ILIKE within one search() sees an empty then a non-empty result)."""

    def __init__(self, batches):
        self.batches = batches
        self.i = 0
        self.cursors = []

    def cursor(self):
        rows = self.batches[min(self.i, len(self.batches) - 1)]
        self.i += 1
        cur = FakeCursor(rows)
        self.cursors.append(cur)
        return cur

    def last_sql(self):
        return self.cursors[-1].executed[-1][0]

    def last_params(self):
        return self.cursors[-1].executed[-1][1]


def store(backend, batches, embedder, jurisdiction="lockport-township"):
    conn = FakeConn(batches)
    s = build_store(backend, acquire=lambda: conn, release=lambda c: None,
                    jurisdiction=jurisdiction, embedder=embedder)
    return s, conn


# A canned search row: (section_id, title, page, content, source, similarity)
SEARCH_ROW = ("section-95-1320", "Setbacks", 12, "Front yard setback is 25 feet.", "Lockport Zoning Ordinance", 0.91)


class KnowledgeStoreTest(unittest.TestCase):
    def test_dice_scopes_by_jurisdiction_and_reads_content_column(self):
        s, conn = store("dice", [[SEARCH_ROW]], embedder=lambda q: [0.1, 0.2])
        out = s.search("setbacks", domain="zoning", limit=5)
        sql, params = conn.last_sql(), conn.last_params()
        self.assertIn("FROM knowledge.chunks", sql)
        self.assertIn("content AS text", sql)
        self.assertIn("jurisdiction = %s", sql)
        self.assertIn("domain = %s", sql)
        # params: [emb, jurisdiction, domain, emb, limit]
        self.assertEqual(params[1], "lockport-township")
        self.assertEqual(params[2], "zoning")
        self.assertEqual(params[-1], 5)
        self.assertEqual(out[0]["search_method"], "semantic")
        self.assertEqual(out[0]["similarity"], 0.91)

    def test_zip_local_is_unscoped_and_reads_text_column(self):
        s, conn = store("zip-local", [[SEARCH_ROW]], embedder=lambda q: [0.1, 0.2])
        s.search("setbacks", domain="zoning")
        sql, params = conn.last_sql(), conn.last_params()
        self.assertIn("FROM knowledge_chunks", sql)
        self.assertNotIn("knowledge.chunks", sql)
        self.assertNotIn("jurisdiction", sql)
        self.assertIn("text AS text", sql)        # content_col == 'text' for ZIP-local
        self.assertEqual(params[1], "zoning")     # no jurisdiction param inserted before domain

    def test_falls_back_to_fulltext_when_no_embedder(self):
        s, conn = store("dice", [[SEARCH_ROW]], embedder=lambda q: None)
        out = s.search("setbacks")
        self.assertIn("to_tsvector", conn.last_sql())
        self.assertEqual(out[0]["search_method"], "fulltext")

    def test_ilike_last_resort_when_fulltext_empty(self):
        # First cursor (FTS) returns [], second (ILIKE) returns a row.
        s, conn = store("dice", [[], [SEARCH_ROW]], embedder=lambda q: None)
        out = s.search("setback requirements")
        self.assertIn("ILIKE", conn.last_sql())
        self.assertIn("jurisdiction = %s", conn.last_sql())   # scope still applied
        self.assertEqual(len(out), 1)

    def test_result_shape_is_identical_across_backends(self):
        sd, _ = store("dice", [[SEARCH_ROW]], embedder=lambda q: [0.1])
        sz, _ = store("zip-local", [[SEARCH_ROW]], embedder=lambda q: [0.1])
        rd, rz = sd.search("x")[0], sz.search("x")[0]
        self.assertEqual(set(rd), set(rz))
        for k in ("section_id", "section_title", "page_number", "text", "source_name"):
            self.assertEqual(rd[k], rz[k])

    def test_long_text_is_snippeted_in_search(self):
        long_row = ("s1", "t", 1, "x" * 800, "src", 0.5)
        s, _ = store("dice", [[long_row]], embedder=lambda q: [0.1])
        out = s.search("q")
        self.assertTrue(out[0]["text"].endswith("..."))
        self.assertEqual(len(out[0]["text"]), 603)   # 600 + '...'

    def test_get_section_combines_subchunks_and_scopes(self):
        rows = [
            ("section-95-1320-1", "Setbacks", 12, "Part one.", "Ord"),
            ("section-95-1320-2", "Setbacks", 12, "Part two.", "Ord"),
        ]
        s, conn = store("dice", [rows], embedder=lambda q: None)
        sec = s.get_section("section-95-1320")
        self.assertEqual(sec["text"], "Part one.\n\nPart two.")
        self.assertEqual(sec["source_name"], "Ord")
        self.assertIn("jurisdiction = %s", conn.last_sql())
        self.assertIn("section_id LIKE %s", conn.last_sql())

    def test_get_section_missing_returns_none(self):
        s, _ = store("dice", [[]], embedder=lambda q: None)
        self.assertIsNone(s.get_section("nope"))

    def test_source_name_scoped(self):
        s, conn = store("dice", [[("MCL 211.7cc",)]], embedder=lambda q: None)
        self.assertEqual(s.source_name("assessing-211-7cc"), "MCL 211.7cc")
        self.assertIn("jurisdiction = %s", conn.last_sql())

    def test_zip_local_schema_constants(self):
        self.assertEqual(ZIP_LOCAL_SCHEMA.content_col, "text")
        self.assertIsNone(ZIP_LOCAL_SCHEMA.jurisdiction_col)
        self.assertEqual(DICE_SCHEMA.table, "knowledge.chunks")
        self.assertEqual(DICE_SCHEMA.content_col, "content")
        self.assertEqual(DICE_SCHEMA.jurisdiction_col, "jurisdiction")


if __name__ == "__main__":
    unittest.main()
