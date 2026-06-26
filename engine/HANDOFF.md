# ISV — Handoff (2026-06-26)

Pick-up doc for the **Intelligent Spatial Viewer** engine work. The authoritative spec is
`Desktop/Claude/ISV_BUILD_SPEC.md` (v1.1); decisions/risk log is `engine/DECISIONS.md`;
the engine contract is `engine/README.md`. This file is the "where are we / how do I
continue" summary.

## TL;DR

A source-agnostic engine + capability registry has been extracted from the Parcel Viewer,
the global-bus → AppContext decouple is well underway, AI is optional two ways, and the
first hardening gates are in. **All additive — Parcel Viewer and parcel-studio stay green.**
Build-order (spec §10) **steps 1–4 done; steps 5–6 in progress.**

- **Repo:** `github.com/vanburencountymi-digital-information/parcel-viewer`
- **Branch/commit:** `main` @ `ffc825a` — **pushed to origin** (CI: `.github/workflows/isv-harness.yml`).
- **Tests:** 103 green (95 Node `node:test` + 8 Python `unittest`). Run: `bash engine/run-harness.sh`.
- **Linear:** project **Intelligent Spatial Viewer (ISV)** — `intelligent-spatial-viewer-isv-cd0a9c4c0f9e`. Each DIC ticket has commit-referenced progress comments.

## What's done (status per spec)

| Step | Item | DIC | State |
|---|---|---|---|
| 1 | A1 capability contract (`invoke` seam, AI tri-state, citation envelope) | 567 | done (In Review) |
| 1 | A2 zero-dep eval harness + CI | 576 | done (In Review) |
| 2 | A7a explainer (AI-off facts+statute links / AI-on narration) | 572 | done (In Review) |
| 2 | A7b source-agnostic doc engine | 573 | done (In Review) |
| 2 | A7c live Parcel Ledger | 574 | done (In Review) |
| 3 | A3 injected AppContext + event bus + global-bus guard; config reads → `PS_CONTEXT.config` | 568 | in progress (foundation + 1st `COUNTY→ctx.config` batch) |
| 3 | A4 SelectionManager + feature-highlighter + event-driven info panel | 569 | done through slice 4 (In Review) |
| 3 | A5 source-config registry + source-driven popup; non-parcel sources selectable | 407 | in progress (parcel panel sections migrated; overlays selectable) |
| 4 | B1 AI-mode toggle (opt-in, degrade-to-facts) | 571 | in progress (toggle done; ai-required-theme hide pending) |
| 4 | B4 runtime AI auto-fallback | 580 | in progress (viewer side done; console side pending) |
| 5 | A8 single source of truth for the 5 shared PV/ZIP drawing files | 575 | in progress (source-of-truth + drift guard; runtime-share pending) |
| 6 | C2 manifest schema versioning + migration | 583 | in progress (migration engine done; migrate-on-load pending) |
| 6 | C5 AI-quality eval (citation-accuracy + grounding) | 586 | in progress (deterministic floor done; golden sets + LLM-judge pending) |

## Architecture map (the seams)

Engine (source-agnostic, no domain noun — enforced by `engine/test/engine-smoke.test.js`):
- `engine/capability.js` — `invoke(capId, typedInput, {ai}) → {facts, provenance, narration, meta}`; tri-state AI; citation envelope `{source_id,anchor,span,state}`.
- `engine/capabilities/{explainer,ledger}.core.js` + `register.js` — the two derived capabilities.
- `engine/app-context.js` — AppContext + event bus (`selection-changed`, `active-feature-changed`).
- `engine/selection.js` — feature-agnostic SelectionManager.
- `engine/feature-highlight.js` — MapLibre feature-state highlighter (map injected).
- `engine/source.js` + `engine/popup.js` — source-config registry + source-driven section renderer (formatters: money/acres/label/code-label; tip/style/computed fields).
- `engine/validate-manifest.js` + `engine/schema/manifest.schema.json` + `engine/manifest-version.js` — manifest validation + schema versioning/migration.
- `engine/ai-quality.js` — citation-accuracy + grounding checks (C5).
- `engine/drawing/` — canonical master of the shared drawing stack + `generate.mjs` (→ PV verbatim, ZIP via word-boundary `PS_→ZIP_`).

Viewer bridges (`frontend/public/js/`, the only place that knows `PS_*` / `COUNTY`):
- `pv-app-context.js` → `window.PS_CONTEXT` / `PS_BUS` (lazy getters over the live globals).
- `pv-selection.js` → `window.PS_SELECTION` (SelectionManager on `PS_BUS`).
- `pv-feature-info.js` → `PV_FEATURE_INFO.show/select` (renders any source into `#parcel-info-panel`).
- `pv-explain.js` (explainer, consumes the core), `pv-doc.js` (consumes `ISV_DOC`), `pv-ledger.js`.
- `pv-ai-mode.js` (`PV_AI_MODE`) + `pv-ai-health.js` (`PV_AI_HEALTH`) — AI toggle + auto-fallback.
- `map.js` — drives `PS_SELECTION`, emits bus events, `_PARCEL_INFO_SOURCE` config for panel sections; `wms-feature-info.js` promotes clicked PostGIS overlays into `PV_FEATURE_INFO.select` (non-parcel sources are selectable; parcel click yields).

## How to run + verify (IMPORTANT — read before testing)

- **Harness (no live model, no key):** `bash engine/run-harness.sh` (or `cd engine && node --test` + `python3 -m unittest test.run_explain_contract_test`). Local Python must be **3.10+** (`py`/`python3` = 3.14 here; the Inkscape `python` is 3.8 and fails on agent.py union syntax).
- **Live dockerized viewer:** the stack runs on **localhost:8080** (`docker compose -f infra/docker-compose.viewer.yml up`). After editing `infra/` or nginx config: `docker compose -f infra/docker-compose.viewer.yml up -d web`.
- **Drive it with the preview MCP:** launch.json config **`a11y-proxy`** (port 8091 → proxies to docker 8080; `tools/a11y-proxy.py`, whose gzip bug is fixed). `PS_selectParcelById(id)` selects by DB id (e.g. 45154 = KELLY/Covert, 45628 = Covert Twp). Roads layer: `PS_PG_LAYERS.setOverlay('reference_roads', true)`, layer id `reference_roads-line`, needs zoom ~15.
- **⚠ Preview cache gotcha:** the browser caches `.js` per-file; `location.href='/demo/?x='+Date.now()` busts the HTML but NOT always the cached `.js`. For a clean run, **`preview_stop` then `preview_start`** (fresh context), and/or `fetch(file,{cache:'reload'})` to compare served vs. live. The preview console buffer is a 500-cap ring that does NOT clear on navigation — to test for NEW errors, count `console.error` calls during an action (don't read the stale buffer).
- **⚠ Verify on the real map, not just the static preview** — `PS_MAP` only initializes against the backend (8080), and live verification has already caught bugs the static preview missed (a `PS_onParcelSelect` recursion against `hints.js`).

## Open decisions (team's call — gate A6)

- **A6-a (OPEN):** ZIP DB is in a separate GCP project (`dbapi-473618`) vs the DICE stack (`core-db-475718`) → migrate ZIP's DB into DICE, or federate at the app layer with two credential sets. Shapes the `KnowledgeStore` interface; **A6 coding is blocked on this.**
- **A6-b (RESOLVED):** keep OpenAI `text-embedding-3-small` for ZIP `knowledge_chunks` (see `engine/DECISIONS.md`).
- Do **not** start A6 (DIC-570) until A6-a is decided.

## Behavior change to know

**AI is now opt-in (default OFF)** per B1 (§4.4a). The live viewer **hides Map Buddy until the AI toggle (sparkle, top-right) is clicked**, and explainers show facts + statute links by default. To keep AI on by default for a deployment, set `COUNTY.ai.defaultMode = 'on'`.

## What's next (recommended order)

1. **Finish the in-flight increments** where cheap: A4 (extract `showParcelInfo`'s remaining HTML into the source renderer), A5 (more sections / backend per-source endpoints), B1 (hide toggle for `ai-required` themes — needs manifest→runtime wiring), B4 (console-side fallback + shared health module), A8 (runtime-share the drawing stack via AppContext), C2 (migrate-on-load + Ajv).
2. **Step 5 themes:** **B2** manual Theme Composer (integrate the existing Admin Console module-editors into one versioned manifest — `parcel-viewer/admin/`), then **B3** AI autoconfigure. Unblocked now by C2's versioned schema.
3. **Step 6 hardening gates (before any public multi-county launch):** **C1** tenant isolation (Urgent — row-level scoping, tenant-scoped AI, prompt-injection defense), **C3** AI cost governance (per-tenant quotas + result caching keyed on capability+typed input), **C4** ops/release (canary, per-tenant flags, rollback, monitoring).
4. **A6** only after A6-a is decided.

## Working agreement (kept throughout)

Incremental never big-bang; keep PV + parcel-studio green at every step; AI proposes / human disposes (propose before implementing widely); verify on the live map; commit + Linear-comment per increment; flag provisional contracts (§4.10 YAGNI — v1 contracts will refactor as A6/A7 add real cases). Repo gotcha: edit the **top-level** `parcel-viewer/` checkout (the dice-brain submodule pin can lag).
