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
- **Tests:** 202 green (133 Node `node:test` + 69 Python `unittest`). Run: `bash engine/run-harness.sh`.
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
| 4 | B4 runtime AI auto-fallback | 580 | viewer side done; **console side done** — `admin.js` polls AI health; when unreachable the B3 autoconfigure card degrades to its deterministic baseline (calm notice, manual builder unaffected) and recovers automatically. Live-verified both directions. |
| 5 | A8 single source of truth for the 5 shared PV/ZIP drawing files | 575 | in progress (source-of-truth + drift guard; runtime-share pending) |
| 5 | B2 Theme Composer — manual builder (assemble editors → one §5 manifest) | 578 | in progress (assembler + capability catalog + **Theme Manifest** console module: assemble→validate→export + raw-edit + **save/publish round-trip** through the versioned config store, live-verified; only the live store provisioning (DIC-464/400) is external) |
| — | A6 backend convergence — **KnowledgeStore + ParcelStore** (decouple knowledge + parcel access; DICE + ZIP-local backends) | 570 | in progress (KnowledgeStore + ParcelStore built & harness-verified; A6-a resolved. **PV `/parcel/{id}` route now reads through `DiceVbcParcelStore` — live-verified on the dockerized viewer.** ZIP/Lockport parcel DATA still not migrated; cross-repo store dedup is a packaging decision) |
| 6 | C4 ops / release | 585 | in progress (inc 1: **monitoring** — map-buddy `GET /status` reports AI availability + result-cache stats + per-tenant quota usage (no secrets) via `cache.stats()`/`usage.snapshot()`; live-verified. inc 2: **per-tenant feature flags** `engine/feature-flags.js` — `resolveCapabilities(manifest, flags)` overrides the manifest capability tri-state per tenant (false=gate-off/rollback, true=canary-on, {ai}=override); reuses the toggle primitives, manifest untouched, harness-tested. Canary deploys/one-click rollback are infra-gated) |
| 6 | C3 AI cost governance | 584 | in progress (inc 1: **result caching** `map-buddy/backend/cache.py` — AI capability results cached on (capability + **tenant** + typed input); identical request → cache hit, no model call. Wired into `/explain` `/autoconfigure` `/judge` (return `cached` flag). Live-verified: 2nd identical /judge 897ms→28ms, cross-tenant misses. inc 2: **per-tenant AI quotas** `map-buddy/backend/usage.py` — config-driven per-tenant/plan limits (default + overrides, `AI_QUOTA_*` env); overage **degrades to AI-off** (`{degraded:true}` → viewer falls back to facts); cache hits don't consume quota. Live-verified (quota=1 → 2nd distinct call degraded, cached repeat free). Tenant-keyed rate-limit (slowapi key_func) still pending) |
| 6 | C1 tenant isolation (Urgent) | 582 | in progress (inc 1: **fail-closed tenant scoping** in KnowledgeStore; **prompt-injection defense** `kb_guard.py`. inc 2: **wired into the live agent loop** — `agent.py` returns KB tool results via `kb_guard.guard_tool_result` (fenced as DATA); all other tools byte-identical. inc 3: **row-level ParcelStore tenant scoping** — `parcel_contract.tenant_predicate` (single-sourced) + opt-in `tenant_column`/`tenant`, fail-closed. inc 4: **DB-layer RLS** — `county-data-services/migrations/015_tenant_isolation_rls.sql` (RLS on `geo.parcel_geometry` keyed on `app.current_tenant`; unset = no rows, fail-closed) + `scripts/test_tenant_rls.sh` **proves cross-tenant isolation against a throwaway postgres** (VBC≠SJC, unset=0). Deploy-with-app (app must `SET app.current_tenant`). |
| 6 | C2 manifest schema versioning + migration | 583 | in progress (migration engine + **migrate-on-load seam** done & live-verified; Ajv swap deferred) |
| 6 | C5 AI-quality eval (citation-accuracy + grounding) | 586 | in progress (explainer citation/grounding floor done; **generalized to the §6.4 envelope** (`checkEnvelope`) + a **theme-composer grounding gate** (`evaluateComposer`). **Live LLM-judge done:** map-buddy `/judge` (`run_grounding_judge`, forced `report_grounding_verdict` tool) scores grounding + citation-accuracy — the non-deterministic gate before prompt/model changes ship; live-verified catching a hallucination. **Golden corpus** `fixtures/golden-composer.json` + `golden-composer.test.js` pin representative briefs → expected themes through the deterministic gate. C5 essentially complete.) |

## Architecture map (the seams)

Engine (source-agnostic, no domain noun — enforced by `engine/test/engine-smoke.test.js`):
- `engine/capability.js` — `invoke(capId, typedInput, {ai}) → {facts, provenance, narration, meta}`; tri-state AI; citation envelope `{source_id,anchor,span,state}`.
- `engine/capabilities/{explainer,ledger}.core.js` + `register.js` — the two derived capabilities.
- `engine/app-context.js` — AppContext + event bus (`selection-changed`, `active-feature-changed`).
- `engine/selection.js` — feature-agnostic SelectionManager.
- `engine/feature-highlight.js` — MapLibre feature-state highlighter (map injected).
- `engine/source.js` + `engine/popup.js` — source-config registry + source-driven section renderer (formatters: money/acres/label/code-label; tip/style/computed fields).
- `engine/validate-manifest.js` + `engine/schema/manifest.schema.json` + `engine/manifest-version.js` + `engine/load-manifest.js` — manifest validation, schema versioning/migration, and the canonical `loadManifest()` migrate-on-load seam (migrate→validate in one place).
- `engine/manifest-assemble.js` + `engine/capability-catalog.js` — B2 manual builder: assemble a §5 theme manifest from the console editor slices (source-agnostic; noun-free, in the §4.1 guard) + the capability vocabulary/default AI tri-state (data module).
- `engine/ai-quality.js` — citation-accuracy + grounding checks (C5).
- `engine/drawing/` — canonical master of the shared drawing stack + `generate.mjs` (→ PV verbatim, ZIP via word-boundary `PS_→ZIP_`).

Viewer bridges (`frontend/public/js/`, the only place that knows `PS_*` / `COUNTY`):
- `pv-app-context.js` → `window.PS_CONTEXT` / `PS_BUS` (lazy getters over the live globals).
- `pv-selection.js` → `window.PS_SELECTION` (SelectionManager on `PS_BUS`).
- `pv-feature-info.js` → `PV_FEATURE_INFO.show/select` (renders any source into `#parcel-info-panel`).
- `pv-explain.js` (explainer, consumes the core), `pv-doc.js` (consumes `ISV_DOC`), `pv-ledger.js`.
- `pv-ai-mode.js` (`PV_AI_MODE`) + `pv-ai-health.js` (`PV_AI_HEALTH`) — AI toggle + auto-fallback.
- `pv-manifest.js` (`PV_MANIFEST`) — surfaces the engine's `loadManifest()` to the browser; boot is a no-op until a real theme manifest exists (COUNTY isn't one), then migrates-on-load → `PS_MANIFEST_LOADED`.
- `map.js` — drives `PS_SELECTION`, emits bus events, `_PARCEL_INFO_SOURCE` config for panel sections; `wms-feature-info.js` promotes clicked PostGIS overlays into `PV_FEATURE_INFO.select` (non-parcel sources are selectable; parcel click yields).

## How to run + verify (IMPORTANT — read before testing)

- **Harness (no live model, no key):** `bash engine/run-harness.sh` (or `cd engine && node --test` + `python3 -m unittest test.run_explain_contract_test`). Local Python must be **3.10+** (`py`/`python3` = 3.14 here; the Inkscape `python` is 3.8 and fails on agent.py union syntax).
- **Live dockerized viewer:** the stack runs on **localhost:8080** (`docker compose -f infra/docker-compose.viewer.yml up`). After editing `infra/` or nginx config: `docker compose -f infra/docker-compose.viewer.yml up -d web`.
- **Drive it with the preview MCP:** launch.json config **`a11y-proxy`** (port 8091 → proxies to docker 8080; `tools/a11y-proxy.py`, whose gzip bug is fixed). `PS_selectParcelById(id)` selects by DB id (e.g. 45154 = KELLY/Covert, 45628 = Covert Twp). Roads layer: `PS_PG_LAYERS.setOverlay('reference_roads', true)`, layer id `reference_roads-line`, needs zoom ~15.
- **⚠ Preview cache gotcha:** the browser caches `.js` per-file; `location.href='/demo/?x='+Date.now()` busts the HTML but NOT always the cached `.js`. For a clean run, **`preview_stop` then `preview_start`** (fresh context), and/or `fetch(file,{cache:'reload'})` to compare served vs. live. The preview console buffer is a 500-cap ring that does NOT clear on navigation — to test for NEW errors, count `console.error` calls during an action (don't read the stale buffer).
- **⚠ Verify on the real map, not just the static preview** — `PS_MAP` only initializes against the backend (8080), and live verification has already caught bugs the static preview missed (a `PS_onParcelSelect` recursion against `hints.js`).

## A6 gate — UPDATED 2026-06-26

- **A6-a (RESOLVED → option (a)):** Drake migrated ZIP's `knowledge_chunks` → **`knowledge.chunks`** in db-dice (`core-db-475718`) — 657 rows, pgvector, `jurisdiction` column, `text`→`content` (`county-data-services 39296c5`). The **KnowledgeStore half is unblocked and BUILT** (see below).
- **A6-b (RESOLVED):** keep OpenAI `text-embedding-3-small` (`engine/DECISIONS.md`).
- **Still blocked — `ParcelStore` ZIP/Lockport impl:** Lockport parcel geometry/assessment/zoning data is **not yet in db-dice**. Drake deferred it pending a team DB-shape decision (`assessing.sjc_parcels` vs generalized `assessing.parcels` + county discriminator), a `zoning.parcel_zones` schema, and the Lockport ETL from `repos/zip-poc/data/`. The `ParcelStore` interface + PV(VBC) impl are NOT blocked.

## Behavior change to know

**AI is now opt-in (default OFF)** per B1 (§4.4a). The live viewer **hides Map Buddy until the AI toggle (sparkle, top-right) is clicked**, and explainers show facts + statute links by default. To keep AI on by default for a deployment, set `COUNTY.ai.defaultMode = 'on'`.

## What's next (recommended order)

1. **Finish the in-flight increments** where cheap: A4 (extract `showParcelInfo`'s remaining HTML into the source renderer), A5 (more sections / backend per-source endpoints), B1 (hide toggle for `ai-required` themes — needs manifest→runtime wiring), B4 (console-side fallback + shared health module), A8 (runtime-share the drawing stack via AppContext), C2 (**migrate-on-load done**; Ajv swap still deferred — see DECISIONS).
2. **Step 5 themes:** **B3 AI autoconfigure (DIC-579) — inc 1 done:** `engine/capabilities/theme-composer.core.js` (registered, `ai-optional`) turns a brief → a **deterministic, schema-valid draft manifest + rationale + provenance** (facts-parity: draft is identical AI-on/off; AI only adds prose rationale via the `fetchComposerNarration` narrate seam). Reuses the B2 assembler + catalog. Admin Console "Theme Manifest" module has an **AI autoconfigure** card (brief → draft into the editor for review; works with no AI). **B3 inc 2 (live transport) done:** map-buddy `/autoconfigure` (`run_autoconfigure`, forced `propose_theme_refinement` tool call — narrates over the deterministic draft, never originates it) + the console posts to it when AI is reachable and shows the AI rationale + suggested tweaks over the draft. **Live-verified with the real model** at `/admin/` (point the console at the local map-buddy via `window.MAP_BUDDY_API='/map-buddy-api'`; prod uses `COUNTY.endpoints.mapBuddy` = Cloud Run, which needs the endpoint deployed). 4 contract tests (no live model) in `run_explain_contract_test.py`. **B2** manual Theme Composer — **inc 1 + inc 2 done** (engine assembler + capability catalog + "Theme Manifest" console module; assemble→validate→export + validated raw-edit + **Save/Publish round-trip** — the manifest is persisted as the canonical `config.manifest` through the existing draft/publish store and PREFERRED on reopen, so open→edit→save→reopen is lossless; "Re-assemble from modules" is the no-one-way-door escape; validate-before-save guard). Live-verified at `/admin/` (the live writable store DIC-464/400 is the only external dep; Save degrades to the standard 503 notice until then). Remaining B2 polish: structured (non-raw) editors for capabilities/persona; reconcile the assembled manifest with module edits made AFTER a manifest was saved. Then **B3** AI autoconfigure (drafts into the same Theme Manifest editor).
3. **Step 6 hardening gates (before any public multi-county launch):** **C1** tenant isolation (Urgent — row-level scoping, tenant-scoped AI, prompt-injection defense), **C3** AI cost governance (per-tenant quotas + result caching keyed on capability+typed input), **C4** ops/release (canary, per-tenant flags, rollback, monitoring).
4. **A6** — A6-a resolved (option a). **KnowledgeStore + ParcelStore done** (`ZIP/zip-poc/backend/{knowledge_store,parcel_store}.py`; `tools.py` delegates behavior-identically; harness-tested incl. a `zip_legacy_view` parity oracle). ParcelStore canonical record normalizes both ZIP-local (flat `parcels`) and DICE/VBC (`geo.parcel_geometry ⋈ assessing.vbc_parcels`). **PV `/parcel/{id}` now reads through `DiceVbcParcelStore`** (`backend/parcel_viewer/stores/parcel_store.py`): store owns the schema-coupled SQL, route formats the `raw` row → identical Feature; `canonical` is the cross-backend record. **Live-verified** (rebuild `api`, `/api/parcel/45154` + on-map select, 0 errors). **D1 store-contract dedup DONE:** the canonical-parcel record shape is now defined ONCE in `engine/stores/parcel_contract.py` (master) and generated verbatim into both backends (`node engine/stores/generate.mjs`), with a drift-guard (`engine/test/parcel-contract-sync.test.js`) — same single-source pattern as the A8 drawing stack. Both ParcelStore impls (PV psycopg3 / ZIP psycopg2) build via the shared `canonical_parcel()`; the impls stay per-backend (drivers differ), only the shape is shared. Next A6 steps: (a) wire db-dice creds + live-smoke `ZIP_KNOWLEDGE_BACKEND=dice` / `ZIP_PARCEL_BACKEND=dice-vbc`; (b) `ParcelStore` ZIP/Lockport DATA migration (blocked on Drake + the `assessing.sjc_parcels`-vs-generalized decision); (c) the map-buddy↔ZIP execution-layer merge (the A6 body).

## Working agreement (kept throughout)

Incremental never big-bang; keep PV + parcel-studio green at every step; AI proposes / human disposes (propose before implementing widely); verify on the live map; commit + Linear-comment per increment; flag provisional contracts (§4.10 YAGNI — v1 contracts will refactor as A6/A7 add real cases). Repo gotcha: edit the **top-level** `parcel-viewer/` checkout (the dice-brain submodule pin can lag).
