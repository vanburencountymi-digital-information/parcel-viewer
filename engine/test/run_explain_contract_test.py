"""run_explain_contract_test.py — Python half of the ISV harness (A2).

Proves the explainer's AI layer (map-buddy/backend/agent.py `run_explain`) honors the
capability contract WITHOUT a live model, a key, or even the anthropic SDK installed:

  - structured output: the model is FORCED to the `render_explanation` tool, and the
    validated tool input is returned (the stable shape the frontend lays out).
  - narrate-from-truth (§4.3, §6.5): run_explain only narrates the caller-supplied
    `facts` — it assembles no figures of its own; the facts it sends to the model are
    exactly the facts it was given.
  - grounded provenance (§4.8): the curated MI statute corpus is injected as system
    context so the model "narrates, never originates" its citations.

Zero-dependency: the anthropic SDK is stubbed and the model client is monkeypatched,
so this runs under stock `python -m unittest`. (Run via pytest too if available.)
"""
import json
import os
import sys
import types
import unittest
from pathlib import Path

# Stub the anthropic SDK so importing agent.py needs no real dependency / API key.
if "anthropic" not in sys.modules:
    _fake = types.ModuleType("anthropic")
    class _FakeAnthropic:  # noqa: N801
        def __init__(self, *a, **k):
            pass
    _fake.Anthropic = _FakeAnthropic
    sys.modules["anthropic"] = _fake

os.environ.setdefault("ANTHROPIC_API_KEY", "test-key")  # never used — client is mocked

# map-buddy/backend is parcel-viewer/map-buddy/backend, two levels above engine/test.
_BACKEND = Path(__file__).resolve().parents[2] / "map-buddy" / "backend"
sys.path.insert(0, str(_BACKEND))

import agent  # noqa: E402


class _Block:
    """Stand-in for an anthropic content block."""
    def __init__(self, type, name=None, input=None, text=None):
        self.type = type
        self.name = name
        self.input = input
        self.text = text


class _Response:
    def __init__(self, content):
        self.content = content


class _FakeMessages:
    def __init__(self, response):
        self._response = response
        self.calls = []

    def create(self, **kwargs):
        self.calls.append(kwargs)
        return self._response


class _FakeClient:
    def __init__(self, response):
        self.messages = _FakeMessages(response)


_GOOD_EXPLANATION = {
    "summary": "Your assessed value is $98,000.",
    "sections": [{"heading": "What these mean", "body": "Plain-language body."}],
    "glossary": [{"term": "Taxable Value (TV)", "definition": "The $72,340 your taxes are levied on."}],
    "statutes": [{"name": "Taxable Value cap (Proposal A)", "citation": "MCL 211.27a(2)", "plain": "TV rises by the lesser of 5% or CPI."}],
    "disclaimer": "Educational only; the assessor is the authority.",
}

FACTS = {"pin": "80-08-032-002-00", "assessed_value": 98000, "taxable_value": 72340}


class RunExplainContractTest(unittest.TestCase):
    def _patch_client(self, response):
        client = _FakeClient(response)
        agent._get_client = lambda: client  # bypass real Anthropic construction
        return client

    def test_returns_structured_explanation(self):
        self._patch_client(_Response([_Block("tool_use", name="render_explanation", input=_GOOD_EXPLANATION)]))
        out = agent.run_explain("assessment", FACTS)
        self.assertEqual(out["summary"], _GOOD_EXPLANATION["summary"])
        self.assertIn("statutes", out)

    def test_forces_render_explanation_tool(self):
        client = self._patch_client(_Response([_Block("tool_use", name="render_explanation", input=_GOOD_EXPLANATION)]))
        agent.run_explain("assessment", FACTS)
        kwargs = client.messages.calls[0]
        self.assertEqual(kwargs["tool_choice"], {"type": "tool", "name": "render_explanation"})
        self.assertEqual(kwargs["tools"][0]["name"], "render_explanation")

    def test_narrates_only_caller_facts(self):
        # narrate-from-truth: the exact facts we pass are what the model is shown;
        # run_explain originates no figures of its own.
        client = self._patch_client(_Response([_Block("tool_use", name="render_explanation", input=_GOOD_EXPLANATION)]))
        agent.run_explain("assessment", FACTS)
        user_msg = client.messages.calls[0]["messages"][0]["content"]
        self.assertIn('"assessed_value": 98000', user_msg)
        self.assertIn("80-08-032-002-00", user_msg)

    def test_grounds_on_curated_statute_corpus(self):
        client = self._patch_client(_Response([_Block("tool_use", name="render_explanation", input=_GOOD_EXPLANATION)]))
        agent.run_explain("assessment", FACTS)
        system = client.messages.calls[0]["system"]
        system_text = system[0]["text"] if isinstance(system, list) else system
        self.assertIn("MCL 211.27a", system_text)            # the corpus is injected
        self.assertIn("cite", system_text.lower())           # "narrate, never originate" discipline

    def test_raises_when_model_skips_the_tool(self):
        # If the model freelances a text answer instead of the structured tool, fail
        # loudly rather than passing through ungrounded prose.
        self._patch_client(_Response([_Block("text", text="here is some prose")]))
        with self.assertRaises(RuntimeError):
            agent.run_explain("assessment", FACTS)

    def test_unsupported_topic_raises(self):
        with self.assertRaises(ValueError):
            agent.run_explain("not-a-topic", FACTS)

    def test_explain_tool_requires_the_five_fields(self):
        req = agent._EXPLAIN_TOOL["input_schema"]["required"]
        self.assertEqual(set(req), {"summary", "sections", "glossary", "statutes", "disclaimer"})

    def test_explainer_profiles_are_serializable_without_secrets(self):
        pub = agent.explainer_profiles_public()
        ids = {p["id"] for p in pub}
        self.assertIn("assessment", ids)
        self.assertIn("tax_description", ids)
        # The serialized view exposes prompt + context, never a client/key.
        self.assertNotIn("api_key", json.dumps(pub))

    # ── B3 autoconfigure refinement (DIC-579) — same forced-tool discipline ──────
    def test_autoconfigure_returns_refinement(self):
        ref = {"rationale": "Fits the brief.", "suggestions": [{"field": "capabilities.search", "change": "enable AI"}]}
        self._patch_client(_Response([_Block("tool_use", name="propose_theme_refinement", input=ref)]))
        out = agent.run_autoconfigure({"topic": "zoning"}, {"tenant": "vanburen", "capabilities": {"search": {"ai": "no-ai"}}})
        self.assertEqual(out["rationale"], "Fits the brief.")
        self.assertEqual(out["suggestions"][0]["field"], "capabilities.search")

    def test_autoconfigure_forces_its_tool(self):
        client = self._patch_client(_Response([_Block("tool_use", name="propose_theme_refinement", input={"rationale": "ok"})]))
        agent.run_autoconfigure({"topic": "x"}, {"tenant": "t"})
        kwargs = client.messages.calls[0]
        self.assertEqual(kwargs["tool_choice"], {"type": "tool", "name": "propose_theme_refinement"})
        self.assertEqual(kwargs["tools"][0]["name"], "propose_theme_refinement")

    def test_autoconfigure_narrates_over_the_given_draft(self):
        # The model is shown the deterministic draft as grounding — it never originates one.
        client = self._patch_client(_Response([_Block("tool_use", name="propose_theme_refinement", input={"rationale": "ok"})]))
        agent.run_autoconfigure({"topic": "zoning"}, {"tenant": "vanburen", "id": "viewer-vanburen"})
        user_msg = client.messages.calls[0]["messages"][0]["content"]
        self.assertIn('"tenant": "vanburen"', user_msg)
        self.assertIn("DETERMINISTIC DRAFT MANIFEST", user_msg)

    def test_autoconfigure_raises_when_tool_skipped(self):
        self._patch_client(_Response([_Block("text", text="here is some prose instead")]))
        with self.assertRaises(RuntimeError):
            agent.run_autoconfigure({"topic": "x"}, {"tenant": "t"})

    # ── C5 LLM-judge grounding gate (DIC-586) — forced verdict tool ──────────────
    def test_judge_returns_a_verdict(self):
        verdict = {"grounded": False, "citations_ok": False, "issues": ["invented $500,000 figure"]}
        self._patch_client(_Response([_Block("tool_use", name="report_grounding_verdict", input=verdict)]))
        out = agent.run_grounding_judge("The value is $500,000.", {"assessed_value": 98000})
        self.assertFalse(out["grounded"])
        self.assertIn("invented $500,000 figure", out["issues"])

    def test_judge_forces_its_tool_and_shows_both_sides(self):
        client = self._patch_client(_Response([_Block("tool_use", name="report_grounding_verdict",
                                                      input={"grounded": True, "citations_ok": True, "issues": []})]))
        agent.run_grounding_judge("Assessed value is $98,000.", {"assessed_value": 98000})
        kwargs = client.messages.calls[0]
        self.assertEqual(kwargs["tool_choice"], {"type": "tool", "name": "report_grounding_verdict"})
        user_msg = kwargs["messages"][0]["content"]
        self.assertIn("GROUNDING TRUTH", user_msg)
        self.assertIn("AI OUTPUT", user_msg)

    def test_judge_raises_when_tool_skipped(self):
        self._patch_client(_Response([_Block("text", text="looks fine to me")]))
        with self.assertRaises(RuntimeError):
            agent.run_grounding_judge("x", {})


if __name__ == "__main__":
    unittest.main(verbosity=2)
