"""run_citation_extract_test.py — Map Buddy §6.4 citation extraction (DIC-522) coverage.

Proves the chat backend turns vetted MCL mentions in an AI answer into §6.4 citation
envelopes (so they surface into the KB-backed Sources panel), and ONLY vetted ones —
the citation-first guard (§4.5): an invented MCL never becomes a clickable "source".
"""
import sys
import unittest
from pathlib import Path

# citations.py lives in the PV map-buddy backend.
MB_BACKEND = Path(__file__).resolve().parents[2] / "map-buddy" / "backend"
sys.path.insert(0, str(MB_BACKEND))

from citations import extract_citations  # noqa: E402


class CitationExtractTest(unittest.TestCase):
    def test_extracts_vetted_mcl_as_envelope(self):
        out = extract_citations("Under Proposal A, your Taxable Value is capped (MCL 211.27a).")
        self.assertEqual(len(out), 1)
        env = out[0]
        self.assertEqual(env["anchor"], "211.27a")
        self.assertEqual(env["source_id"], "MCL 211.27a")
        self.assertTrue(env["span"])  # carries the statute name for display/fallback
        # Shape matches what pv-citations' delegated handler reads (source_id/anchor/span).
        self.assertEqual(set(env), {"source_id", "anchor", "span"})

    def test_drops_subsection_to_base_anchor(self):
        # "211.27a(2)" must resolve to the section the KB holds (211.27a).
        out = extract_citations("The cap is the lesser of 5% or CPI (MCL 211.27a(2)).")
        self.assertEqual(out[0]["anchor"], "211.27a")

    def test_dedupes_and_preserves_order(self):
        text = ("Appeals go to the Board of Review (MCL 211.30), then the Tax Tribunal "
                "(MCL 205.731). The Board (MCL 211.30) is first.")
        anchors = [c["anchor"] for c in extract_citations(text)]
        self.assertEqual(anchors, ["211.30", "205.731"])  # 211.30 once, in first-seen order

    def test_invented_mcl_is_not_surfaced(self):
        # Citation-first: an MCL not in the vetted corpus is ignored.
        out = extract_citations("This is governed by MCL 999.999, definitely.")
        self.assertEqual(out, [])

    def test_no_mcl_no_citations(self):
        self.assertEqual(extract_citations("Your parcel is about 2.5 acres."), [])

    def test_empty_text(self):
        self.assertEqual(extract_citations(""), [])
        self.assertEqual(extract_citations(None), [])

    def test_pre_two_section_form(self):
        out = extract_citations("The PRE exempts up to 18 mills (MCL 211.7cc and 211.7dd).")
        # 211.7cc is in the corpus; 211.7dd is not a separate section there → one envelope.
        self.assertEqual([c["anchor"] for c in out], ["211.7cc"])


if __name__ == "__main__":
    unittest.main()
