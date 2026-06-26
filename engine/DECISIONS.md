# ISV — Risk & Decisions Log (A1/A2 check-in, 2026-06-26)

Surfaced, not resolved. "AI proposes, human disposes" (§4.12) — including me.

## Resolved this pass (with your input)

| # | Decision | Choice |
|---|---|---|
| D1 | Contract + harness home | **In-repo `parcel-viewer/engine/`** (incremental; extract to a shared package once a 2nd viewer consumes it). |
| D2 | Harness runtime | **Node `node:test` (JS cores) + stdlib `unittest` (Python `run_explain`)**, one CI workflow, zero third-party deps. (You deferred this to me.) |
| D3 | AI-off explainer behavior | **Facts + curated statute links, no prose** (§4.5). Baked into the engine core's provenance + harness; UI surfacing is A7a (see O1). |

## Open decisions — need the team (BLOCKING the work they gate)

| # | Decision | Why it's blocking | Options |
|---|---|---|---|
| **A6-a** | ZIP DB cross-GCP boundary (`dbapi-473618` vs `core-db-475718`) | `KnowledgeStore` interface shape depends on it; largest A6 lift | (a) migrate ZIP DB into the DICE project; (b) federate at the app layer with two credential sets |
| **A6-b** | ZIP `knowledge_chunks` embedding provider (OpenAI `text-embedding-3-small` — the only OpenAI dep in the stack) | gates the `KnowledgeStore` implementation | keep OpenAI; re-embed with a hosted/open model; replace vector search |
| **O1** | Engine-serving for the browser | the live `pv-explain.js` can't `require` `engine/` — nginx serves only `frontend/public`. Needed before A7a wires the live UI to the cores. | **(a) CHOSEN (provisional default, revisit at A7a):** add a volume + `location /engine/` mount so `engine/` stays the single canonical home. (b) relocate browser bundles under `frontend/public/js/engine/`. |

I am **not** picking A6-a/A6-b (your explicit instruction). O1 resolved to **(a)** —
fully reversible (~2 infra lines + script-src paths; only one consumer, no blast
radius), revisit at A7a if it feels wrong.

## Risks / watch-items

- **Corpus duplication (R1):** `engine/data/mi-tax-statutes.json` mirrors the prose
  `_MI_TAX_STATUTES` in `map-buddy/backend/agent.py`. Two copies can drift until A7a/A6
  converge them. Mitigation noted in both files; convergence is an A7a task.
- **parcel-studio (R2):** consumes `window.PS_*` as a submodule. A1/A2 are additive and
  touch none of it — PV and parcel-studio stay green. The contract is injection-based so
  A3 can adopt it without breaking the submodule.
- **Repo drift (R3):** the top-level `parcel-viewer/` checkout (998c4d8) is **ahead** of
  the dice-brain submodule pin (`c46c2f0`). Engine work landed in the **top-level** live
  copy; the monorepo submodule must be bumped to follow.
- **Provisional contract (R4):** v1 is derived from 2 capabilities. Expect refactors as
  A7c (ledger UI), A6 (stores), and the Citation Renderer (DIC-522) add real cases. Do
  not harden it prematurely (§4.10).

## Done

A1 contract, A2 harness, **A7a** explainer (live, browser-verified), **A7b** doc/template
(source-agnostic `ISV_DOC` with injected map handle; pv-doc delegates), **A7c** Parcel
Ledger (live `/parcel/{id}/history` via the ledger capability, decoupled from the Packet
modal into `pv-ledger.js`; browser-verified). Harness: 50 tests (42 JS + 8 Py).

## In progress — A3 (kill global bus)

**Increment 1 DONE & browser-verified** (additive, strangler-fig — nothing removed,
PV + parcel-studio green): `engine/app-context.js` (source-agnostic AppContext + event
bus), `frontend/public/js/pv-app-context.js` (viewer bridge → `window.PS_CONTEXT` /
`PS_BUS` via lazy getters over the live PS_* globals), `engine/MIGRATION.md` (file-by-file
path), and a CI **guard** (`test/guard-globals.test.js`) that fails if any engine file
reintroduces a PS_*/ZIP_* global. Harness: **57 tests** (49 JS + 8 Py).

Remaining A3: migrate the ~175 global reads file-by-file per MIGRATION.md (start with
`COUNTY`→`ctx.config`). The `PS_STATE` migration IS A4.

## In progress — A4 (SelectionManager, the keystone & riskiest)

**Slice 1 DONE & browser-verified** (additive, ZERO map.js edits): `engine/selection.js`
(feature-agnostic SelectionManager — select/clear/setActive on `{sourceId,id,properties}`,
emits `selection-changed`/`active-feature-changed` on the bus) + `frontend/public/js/pv-selection.js`
(creates it on PS_BUS as `window.PS_SELECTION`; mirrors the viewer's selection onto the
bus by intercepting `PS_onParcelSelect` via an accessor that **preserves any downstream
handler** — parcel-studio coexistence verified in-browser). Harness: **64 tests** (56 JS + 8 Py).

Remaining A4 slices (need their own checkpoints — they cut into map.js):
- Slice 2: route map.js feature-state highlight to a `selection-changed` subscription.
- Slice 3: render the info panel from `active-feature-changed` (decouple `showParcelInfo`'s
  inline build), keeping `PS_selectParcel()`/`PS_onParcelSelect` intact for parcel-studio.
  Also emit clears (the hook isn't called on deselect, so slice 1 mirrors selects only).

## Not started (next up)

A4 slices 2–3 → A5 (source abstraction); A6 (gated on A6-a/A6-b); B* (AI toggle / Theme
Composer); C* (hardening).
