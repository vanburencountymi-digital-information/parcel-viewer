# ISV Engine — Capability Contract (A1) + Eval Harness (A2)

> **Status:** v1, **provisional** (ISV_BUILD_SPEC §4.10 — derived from two real
> capabilities, expected to be refactored as A6/A7 add more). First consumer:
> Parcel Viewer. Home: `parcel-viewer/engine/` (in-repo, incremental — not yet a
> shared package; extract once a second viewer actually consumes it).

This directory is the start of the **source-agnostic engine**: the capability
contract (artifact #2, §6) and the CI test/eval harness (A2). It contains **no
domain vocabulary** — the word "parcel" does not appear in engine code, and a test
(`engine-smoke.test.js`) enforces that.

## A1 — the capability contract

One caller-agnostic seam (`capability.js`):

```
invoke(capabilityId, typedInput, { ai }) -> { capability, facts, provenance, narration, meta }
```

Each capability is registered as:

```js
registry.register({
  id,                         // string
  aiMode,                     // 'no-ai' | 'ai-optional' | 'ai-required'   (§4.7 tri-state)
  core,                       // (typedInput) -> { facts, provenance }     PURE, no model (§4.3)
  narrate?,                   // (facts, provenance, ctx) -> structuredOutput | null   (AI layer)
})
```

**Two front doors over one core** (§6.2): the UI/engine supplies `typedInput`
directly (no model — this is what makes AI-off work for free); Map Buddy resolves the
same `typedInput` from natural language and calls the same `core` as a tool. AI is
just another caller.

### What the contract guarantees (enforced in code)

| Invariant | How it's enforced |
|---|---|
| §4.1 source-agnostic | no domain noun in engine code; `engine-smoke.test.js` greps for it |
| §4.2 typed→core→structured→provenance | `core()` must return `{ facts, provenance }`; checked in `invoke()` |
| §4.3 AI never in the critical path | `core()` is the only thing on the data path; `narrate()` is never called AI-off (`ai-boundary.test.js`) |
| §4.4 AI optional two ways | `opts.ai` toggle (default off/opt-in) + a throwing/absent narrator degrades instead of erroring |
| §4.6 facts-parity | `facts`+`provenance` identical AI-on/off; only `narration` differs (`facts-parity.test.js`) |
| §4.7 tri-state | `aiApplies()`; `no-ai` rejects a narrator, `ai-required` requires one |
| §4.8 provenance first-class | every entry is the citation envelope `{source_id, anchor, span, state}` (§6.4) |

### Derived from two real, opposite capabilities (§4.10, §6.5)

- **explainer** (`capabilities/explainer.core.js`) — `ai-optional`; provenance is the
  **curated MI statute corpus** (`data/mi-tax-statutes.json`); has narration. The
  citable universe AI-on **is** the link set shown AI-off (§4.6 made literal).
- **ledger** (`capabilities/ledger.core.js`) — `no-ai`; provenance is **native to the
  data** (each event's `source_document`); no narration; honest `none` state for
  undocumented events.

Choosing opposites (model-narrated vs. deterministic; curated vs. native provenance)
keeps the contract from being explainer-shaped.

### Flagged provisional (will change)

- The citation-envelope mapping for native-provenance capabilities (ledger →
  `state:'coarse'`) is a best guess pending the KB **Citation Renderer** contract
  (DIC-522) — resolvable locators may upgrade `coarse`→`resolves`.
- `data/mi-tax-statutes.json` **mirrors** the prose corpus `_MI_TAX_STATUTES` in
  `map-buddy/backend/agent.py`. Until A6/A7a converge them, keep them in sync.
- `validate-manifest.js` is a zero-dep **stub** for full JSON-Schema validation;
  `schema/manifest.schema.json` is the real schema, ready for Ajv under C2 (DIC-583).
- `popup.js` is a smoke-test stub seeding A5 (DIC-407), not the source abstraction.

## A2 — the harness

Zero third-party dependencies. Run the whole thing:

```bash
bash engine/run-harness.sh
# or individually:
cd engine && node --test                                   # JS: cores, contract, parity, schema, smoke
cd engine && python -m unittest test.run_explain_contract_test -v   # Python: run_explain structured output
```

CI: `.github/workflows/isv-harness.yml` (Node 20 + Python 3.11). No live model, no
secrets — the anthropic SDK is stubbed and the model client mocked.

| Test file | Proves |
|---|---|
| `explainer.core.test.js` | deterministic facts; figures restated never originated; classifier; PIN breakdown |
| `ledger.core.test.js` | event normalization; native provenance; honest `none` |
| `facts-parity.test.js` | **§4.6** facts/provenance identical AI-on/off; AI-off universe == AI-on citable set; auto-fallback |
| `ai-boundary.test.js` | **§4.3** `narrate()` never runs AI-off; tri-state registration rules |
| `manifest-schema.test.js` | **§5.2** invalid manifest rejected; AI tri-state enum |
| `engine-smoke.test.js` | **§4.1** a non-parcel source renders through the same engine; no domain noun in engine code |
| `run_explain_contract_test.py` | forced `render_explanation` tool; narrate-from-truth; grounded on curated corpus; fails loudly if the model skips the tool |

## Not done here (deliberately — see DECISIONS.md)

- Wiring the **live** `pv-explain.js` to consume these cores in the browser and render
  AI-off statute links: that is **A7a** and needs a small engine-serving decision
  (mount `engine/` vs. relocate browser bundles). Done at the contract level here;
  the live UI is untouched so PV stays green.
- A6 backend convergence and its two open decisions (cross-GCP DB, OpenAI embeddings)
  are surfaced in DECISIONS.md, not started.
