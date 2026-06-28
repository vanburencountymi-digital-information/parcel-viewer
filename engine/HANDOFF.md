# ISV — Handoff (2026-06-27)

Pick-up doc for the **Intelligent Spatial Viewer** engine work. The authoritative spec is
`Desktop/Claude/ISV_BUILD_SPEC.md` (v1.1); decisions/risk log is `engine/DECISIONS.md`;
the engine contract is `engine/README.md`. This file is the "where are we / how do I
continue" summary.

## ⭐ START HERE (next session — 2026-06-28)

**Strategic frame (agreed with the team):** PV & ZIP were POCs; the rebuild's goal is to
reach the point where we **stop rebuilding and start building new capabilities forward**
without future rewrites. **PV is at that inflection (~80%)** — the seams a new capability
plugs into (contract, manifest, capability-gating, source abstraction, injected context,
AI-optional, Citation Renderer) are built and proven on the live viewer. **ZIP is not yet
(~40%)** — only its theme manifest is proven; its frontend is still the `ZIP_*` fork.

**Landed this session (all pushed; parcel-viewer `01531cb`, ZIP `d29d16a`):** canonical
tenant key (`vanburen`→`VBC`); keystone Phases 1–3 + depth (viewer now reads branding/map/
scheme/capabilities/sources/county-overlays from `PS_MANIFEST`); Phase 4 non-contract
read-grind (`PV_PREFS`/`PS_PARCEL_INDEX`→ctx); Phase 5 slice 1 (ZIP Lockport theme manifest);
DIC-575 (all 7 drawing files single-source); **Citation Renderer (DIC-522)** — engine core
+ in-app synchronized Sources panel, the first capability *built forward* on the new
architecture. Harness 204→**221 green**.

**Landed 2026-06-27 (commit `7e92a34`):** ✅ **KB-backed citation resolver (DIC-522)** —
move #1 below is DONE. `pv-citations.js` now resolves citations against the County Knowledge
Base (A6 KnowledgeStore) → full section text + passage-level highlight + true `resolves`
state, with the curated statute corpus kept as fallback (no regression). New map-buddy
`POST /kb/resolve` (jurisdiction-scoped, fail-closed, **no AI-key gate** — citations are
facts). Vendored `kb_store.py` (+ `FixtureKnowledgeStore`) makes it live-verifiable WITHOUT
Drake. Harness **221→230 green**. DEFERRED (gated): `dice` live-smoke + ingesting the VBC
statute corpus into `knowledge.chunks` (today it holds only Lockport zoning). Backend flip
is `KB_BACKEND=dice` — resolver logic identical.

**Also landed 2026-06-27 (commit `32dd5c8`):** ✅ **Map Buddy → Sources 3-way sync (DIC-522,
move #2)** — chat answers now emit §6.4 envelopes (`map-buddy/backend/citations.py`,
citation-first over the vetted corpus) and render a "Sources" row whose `data-cite-*` buttons
drive the SAME KB-backed Sources panel (reuses pv-citations' delegated handler — no new bus
wiring). Chat system prompt now carries the statute reference + a cite-by-MCL instruction.
Harness **230→237 green**. Live-verified (answer cited 211.27a/211.34/211.7cc → click → panel
`resolves` + highlight). The Sources panel now serves BOTH the explainer and Map Buddy.

**Best next moves (pick one):**
1. ~~**KB-backed citation resolver**~~ — ✅ DONE (`7e92a34`).
2. ~~**More citation emitters (Map Buddy → Sources)**~~ — ✅ DONE (`32dd5c8`).
3. **A new capability** — keep validating "build-forward" mode on PV (now the top pick).
   **▶ IN PROGRESS — `cohort-analyze` (analysis suite, DIC-587):** increment 1 (deterministic
   capability core) landed (commit `397285a`): `engine/capabilities/cohort-analyze.core.js`,
   aggregators composition/value-stats/value-change/ownership/area-distribution, source-agnostic
   (config-driven fields, in the §4.1 guard), registered ai-optional w/ narrate seam. Harness
   237→251. **Next:** backend cohort-selection endpoint (buffer/adjacency/named-geo → feature set
   via PostGIS, on the `api` built image), then the **Compare preset** (DIC-589, smallest) and the
   **Neighborhood/Area Profile** flagship (DIC-588). Plan: `[[project_isv_analysis_capability]]`,
   Linear DIC-587/588/589 + DIC-536 catalog. Data: composition+assessment-values+YoY+ownership now;
   market/sales comps gated (DIC-545/352).

   **`view-describe` (vision) is planned** — see `DECISIONS.md` D8–D12 + Linear DIC-555 (refined
   plan): a G1 capability (`core()`=deterministic identify, `narrate()`=vision over an on-demand
   offscreen capture), Map Buddy tool + ADA "Describe this view" mounts, both AI-optional. ⚠ Two
   things need owner sign-off before coding: **AI-default-ON + first-run pill** (reverses §4 #4 /
   DIC-571 — see DECISIONS "OPEN"), and confirm build-order. Honesty rule: NO numbers from the
   vision model (grounding only); §6.4 state `none`; vision = ADA enhancement, never the compliance backbone.
4. **ZIP-onto-engine** (DIC-523) — boot ZIP's frontend from `engine/themes/lockport-township.json`
   on the shared engine; needs ZIP's stack runnable locally + the DIC-575 *runtime*-share.
5. **Unblock the KB**: ingest the VBC statute corpus into `knowledge.chunks` + `KB_BACKEND=dice`
   live-smoke (Drake/dice) — flips both citation features from fixture to the real KB.

**Note (pre-existing, not from this work):** in the a11y-proxy preview the demo's `MapBuddy.mount`
apiBase resolves to a base that 404s/fails; remount with `MapBuddy.mount({apiBase:'/map-buddy-api'})`
to drive the LOCAL map-buddy when verifying AI chat. Worth checking how `demo/index.html` mounts it.

**Don't touch unprompted:** the parcel-studio CONTRACT globals (`PS_MAP`/`PS_STATE`/drawing
`PS_*`) — that's Drake's project; migrate only in lockstep with it (not runnable here).
ZIP repo has two pre-existing non-ours files (`init-db/02-seed.sh`, `files.zip`) — leave them.
parcel-viewer has an untracked `docs/isv-theme-concepts.md` (not authored this session).

## TL;DR (read the honest status map below before assuming completeness)

The **capability contract, the data-abstraction stores, the manifest+Theme-Composer stack,
the AI capabilities, and ALL FIVE hardening gates (C1–C5)** are built and verified (harness
and/or live). What is **NOT done** is the integration spine that makes it actually "one
engine, N themes": the live viewer still boots from `window.COUNTY` (not a manifest), the
global bus isn't killed, and ZIP isn't a theme yet. **That spine is the larger remaining
half, and it's mostly unblocked** — Phase 0 (manifest exists at runtime) is the first cut, done.

- **Repos (all `main`):** parcel-viewer `98bae8a` (keystone Phases 1–3+depth, Phase 4 non-contract read-grind, Phase 5 slice 1, DIC-575 codegen, **Citation Renderer DIC-522** landed this session; **push pending**) · ZIP/zip-poc `17ff90d` (+ local `d29d16a` measure-tool) · county-data-services `0838fd5`. CI: `.github/workflows/isv-harness.yml`.
- **Tests:** 221 green (152 Node `node:test` + 69 Python `unittest`). Run: `bash engine/run-harness.sh`. (Drift guard covers all 7 shared drawing files.)
- **Big session 2026-06-27:** finished B3 (live AI transport), C1 (DB RLS, verified on throwaway postgres), C3 (cache+quotas), C4 (/status + feature-flags), C5 (LLM-judge + golden corpus), and started the keystone (Phase 0 manifest-boot). Worked around the weekend blockers — see gotchas below.

## ⚠ Honest status map (what's REAL vs. scaffolding — orient here first)

- **🟢 Integrated & live (local dockerized stack):** A2 harness · A7 explainer/ledger/doc · A4/A5 partial (event-driven selection, source-config popup) · A6 ParcelStore→PV `/parcel` route · A8 drawing · B1 toggle · B4 fallback (viewer+console) · B2/B3 Theme Composer + autoconfigure **at `/admin/`** (incl. live AI refinement) · C3 cache+quota / C4 `/status` / C5 `/judge` **on the local map-buddy** · Phase 0 manifest-at-boot.
- **🟡 Built & tested but NOT wired into the live viewer runtime:** A1 `invoke()`/registry seam · C2 migrate-on-load (console only) · KnowledgeStore + `kb_guard` agent wiring (ZIP not running) · ParcelStore tenant scoping (opt-in, PV passes no tenant) · `feature-flags.js` (nothing consumes it) · `ai-quality.js` deterministic checks (harness-only) · **the whole manifest pipeline — nothing at viewer runtime reads `PS_MANIFEST` yet** (Phase 0 only makes it exist).
- **🔴 Not started / substantially incomplete (mostly UNBLOCKED):** A3 kill-the-bus (most ~175 globals unmigrated; parcel-studio depends on them) · A4/A5 full source abstraction · **manifest-driven viewer boot** (Phases 1–4) · **ZIP-as-a-theme** · A6 execution-layer merge.
- **⛔ Blocked (Drake / ZIP / Cloud Run / prod):** apply RLS migration 015 + cross-tenant E2E (writable store DIC-464/400) · A6 `dice` live-smoke + Lockport data migration · deploy map-buddy `/autoconfigure`+`/judge`+`/status`+cache/quota to **Cloud Run** (prod AI routes there, not the bundled one) · cache/quota → DIC-400 shared store · C4 canary deploy + engine rollback · ZIP runnable locally for the merge.

## Open decision — RESOLVED (2026-06-27)

**Canonical tenant key = `manifest.tenant` = `vanburen`** (matches §5.1 spec + Admin Console `COUNTY_KEY`); DB mapping `vanburen → "VBC"` (the value C1 RLS sets as `app.current_tenant`). Single owner: `engine/tenant.js` (`canonicalTenant`/`dbCounty`/`register`, fail-closed null on unknown). `COUNTY.tenant="vanburen"` set in BOTH `frontend/.../county-config.js` AND `backend/parcel_viewer/county_configs/vanburen.json` (the served `/api/config.js` overrides COUNTY — edit both; api is a baked image, rebuild it). Old `van-buren-county` slug demoted to assembler fallback. (commit `d8cea24`, DIC-582.)

## Keystone work — manifest-driven boot (the integration spine)

The real rewrite = make the live viewer run on the engine/manifest, kill the global bus, then ZIP-as-a-theme. Sequenced plan (A3 + manifest-boot interleaved, lowest-risk first):
- **Phase 0 — manifest at boot — DONE & live-verified.** `pv-manifest.js` assembles a COMPLETE manifest from `window.COUNTY` at boot (the §5 manifest **grew** to a COUNTY superset — `parcelNumber`/`labels`/`styling`/`state`/`forms`/`endpoints`/`integrations`/`access` carried via the assembler's generic `opts.passthrough`; schema + `manifest.schema.json` grown). Validated → `window.PS_MANIFEST`. **Additive: COUNTY still drives the viewer; zero behavior change.** (⚠ bust the `.js` cache — preview_stop/start — when verifying engine edits.)
- **Phase 1 — DONE (commit `f38e38e`):** branding name + map center/zoom/extent + default color-scheme read through `PS_MANIFEST` (COUNTY fallback). Boot-ordering fixed: `pv-manifest.js` moved before `map.js` + assembles EAGERLY at parse time, so `PS_MANIFEST` exists before `initMap()`. (DIC-568.)
- **Phase 2 Slice A — DONE (commit `acde0cd`):** `frontend/.../pv-capabilities.js` (`PV_CAPS.isEnabled()` = `resolveCapabilities(PS_MANIFEST, flags)`) — first runtime consumer of `manifest.capabilities` + C4 feature-flags. Default-ON/additive. Gated mapBuddy/print/share/drawing/measure. Flags: `window.PV_FEATURE_FLAGS` → `localStorage 'pv-feature-flags'` → `COUNTY.featureFlags`. Slice B (basic surfaces search/parcelInfo/layers/ledger) deferred. (DIC-585.)
- **Phase 3 — DONE & DEPTH FINISHED (A `cb8cf67` · B1 `17f4938` · B2 `e56a925` · C `4e5d4f8` · D+E `9ca843e`):** (A) parcel source identity from manifest, exposed `window.PV_PARCEL_SOURCE`. (B1) grew the source shape (`source`/`geomType`/`dbSource`/`fields`/`default`/`outlineOnly` + `style` + `role`). (B2) `pg-layers.js` overlay list + paint and `layer-registry.js` from `PV_MANIFEST.vectorOverlays()`. (C) `countyOverlays` from manifest (`role:'county-overlay'`, `PV_MANIFEST.sourcesByRole`). (D) WMS overlays stay module-owned — **decision D6** (federated national datasets, not per-county data). (E) parcel popup — **decision D7**: §5 section-NAME list carried onto the manifest (`PV_PARCEL_SOURCE.popupSections`), rich field-config + formatters + render stay viewer-owned. **Manifest-driven:** parcel identity, vector + county overlay lists/paint, popup section names. **Viewer/module-owned by decision:** WMS mechanics, rich popup config. (DIC-407.)
- **Phase 4 — non-contract read-grind DONE (inc 1 `8a36fd1` · inc 2 `1d81874`):** `COUNTY→ctx.config` (already), `PV_PREFS→ctx.prefs`, `PS_PARCEL_INDEX` reads `→ctx.sourceIndex` (writes + drawing-stack reads stay). Each via a `ctx.X || window.X` helper; strangler-fig invariant `ctx.X === window.X` verified live. See `engine/MIGRATION.md` (steps 1–3 ✅). **REMAINING is the parcel-studio CONTRACT** — `PS_STATE` (= the A4 SelectionManager extraction, not a blind swap) + `PS_MAP` (~11 files) + the drawing-stack `PS_*` (A8): migrate **last, in lockstep with the parcel-studio submodule** (needs it checked out + its integration re-run per batch — NOT runnable in this env). Don't blind-swap them.
- **Phase 5 — slice 1 DONE (commit `1fd9b97`):** ZIP-as-a-theme **manifest** — `engine/themes/lockport-township.json` (zoning viewer, tenant `lockport-township`, ZIP capability mix, AI-optional) validates + round-trips `loadManifest` (harness `test/themes.test.js`) AND loads through the **browser** engine at runtime (fetched `/engine/themes/...` → `PV_MANIFEST.load()` ok, 0 errors). "One engine, N themes" proven at the manifest+runtime level. **REMAINING (gated on ZIP runnable locally):** boot ZIP's actual frontend (`ZIP/zip-poc/frontend/`, its own map.js/overlay-layers parallel to PV) on the SHARED engine modules from this manifest — bigger; needs ZIP's stack up. Also the A6 execution-layer merge (map-buddy↔ZIP tool loops).
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
| 5 | A8 single source of truth for the shared PV/ZIP drawing files | 575 | **all 7 files now single-source** (`engine/drawing/` master + `generate.mjs` → PV verbatim / ZIP `PS_→ZIP_`; per-file `TARGETS` for legend-panel; drift guard covers all 7). measure-tool reconciled (ZIP gains PV's additive `dimensionParcel`). **Runtime-share (one copy via injected namespace) still pending** — the eventual target. (commit `c8196fe`; ZIP side `d29d16a`) |
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
- `engine/citation.js` (`ISV_CITATION`) — **Citation Renderer core (DIC-522 / §6.4)**: `resolveCitation(envelope, resolver)` → render-ready doc + honest degradation (resolves/coarse/none, never over-claims). Resolver injected — **KB-backed** (map-buddy `POST /kb/resolve` over the A6 KnowledgeStore → full text + passage highlight), curated statutes as fallback. Viewer surface = `frontend/.../pv-citations.js` (`PV_CITATIONS`) → in-app `#pv-doc-panel`, bus event `citation-activated`, capability-gated. Explainer statute links emit the envelope (in-app, not new window). Same renderer will serve ZIP's ordinance.
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
- **⚠ Preview cache gotcha — LARGELY FIXED (commit `acde0cd`):** nginx now sends `Cache-Control: no-store` for `/demo/`, `/frontend/public/`, `/engine/` (`infra/nginx.viewer.conf`), so a fresh load fetches current JS. It bit hard this session BEFORE the fix: a heuristically-cached EXISTING file (`map.js`) ran STALE across `preview_stop`/`preview_start` with no error (a NEW file like pv-capabilities.js was fine — no prior cache). If you still suspect a stale entry: in-page `await fetch(file,{cache:'reload'})` then navigate, and/or `preview_stop`+`preview_start`. The preview console buffer is a 500-cap ring that does NOT clear on navigation — to test for NEW errors, count `console.error` calls during an action (don't read the stale buffer).
- **⚠ Verify on the real map, not just the static preview** — `PS_MAP` only initializes against the backend (8080), and live verification has already caught bugs the static preview missed (a `PS_onParcelSelect` recursion against `hints.js`).
- **AI paths ARE live-verifiable locally** (no Drake needed): `parcel-viewer/.env` has an Anthropic key, but the compose `environment:` interpolates `ANTHROPIC_API_KEY` from the host shell (empty) and overrides the env_file — so bring map-buddy up WITH the file: `docker compose -f infra/docker-compose.viewer.yml --env-file .env up -d map-buddy`. The console/viewer resolve the AI base to `COUNTY.endpoints.mapBuddy` = **Cloud Run** (which lacks the new `/autoconfigure`,`/judge`,`/status` + cache/quota); to exercise the LOCAL map-buddy in the browser set `window.MAP_BUDDY_API='/map-buddy-api'` (highest precedence in `explainBase`/`mapBuddyBase`). map-buddy is bind-mounted with `--reload`, so .py edits hot-reload (no rebuild). The PV `api` service is a BUILT image — rebuild it for backend changes: `... up -d --build api`.
- **DB work without db-dice** (Drake gated): prove SQL/policies against a throwaway container — see `county-data-services/scripts/test_tenant_rls.sh` (spins up `postgres:16-alpine`, applies migration 015's policy, asserts cross-tenant isolation + fail-closed). `~/bin/cloud-sql-proxy.exe` exists if you DO want db-dice (Avast Web Shield off during migrations; do NOT run prod DDL unattended).

## A6 gate — UPDATED 2026-06-26

- **A6-a (RESOLVED → option (a)):** Drake migrated ZIP's `knowledge_chunks` → **`knowledge.chunks`** in db-dice (`core-db-475718`) — 657 rows, pgvector, `jurisdiction` column, `text`→`content` (`county-data-services 39296c5`). The **KnowledgeStore half is unblocked and BUILT** (see below).
- **A6-b (RESOLVED):** keep OpenAI `text-embedding-3-small` (`engine/DECISIONS.md`).
- **Still blocked — `ParcelStore` ZIP/Lockport impl:** Lockport parcel geometry/assessment/zoning data is **not yet in db-dice**. Drake deferred it pending a team DB-shape decision (`assessing.sjc_parcels` vs generalized `assessing.parcels` + county discriminator), a `zoning.parcel_zones` schema, and the Lockport ETL from `repos/zip-poc/data/`. The `ParcelStore` interface + PV(VBC) impl are NOT blocked.

## Behavior change to know

**AI is now opt-in (default OFF)** per B1 (§4.4a). The live viewer **hides Map Buddy until the AI toggle (sparkle, top-right) is clicked**, and explainers show facts + statute links by default. To keep AI on by default for a deployment, set `COUNTY.ai.defaultMode = 'on'`.

## What's next (recommended order)

**THE path forward is the keystone phases (see the Keystone section near the top).** The
contract, stores, manifest/Theme-Composer, AI capabilities, and all five hardening gates
are built (status map above). The remaining work is the integration spine:

1. **Phase 1 — route branding + map reads through `PS_MANIFEST`** (COUNTY fallback). First slice that CONSUMES the manifest; establishes the read-migration pattern. **Decide the canonical tenant key first** (see "Open decision" above).
2. **Phase 2 — capability gating from `manifest.capabilities` + wire `feature-flags.js`.** Highest leverage: lights up the built-but-unwired B2/B3/C4 stack in the live viewer.
3. **Phase 3 — sources from `manifest.sources`** (the A5 depth, riskiest — hunt remaining parcel-hardcoded render paths). **Phase 4 — finish the A3 read-migration grind** (file-by-file, parcel-studio re-verified per batch).
4. **Phase 5 — ZIP-as-a-theme** (gated on ZIP runnable locally) — and the **A6 execution-layer merge** (map-buddy↔ZIP tool loops).
5. **Monday/Drake/infra (the ⛔ blocked set):** apply RLS migration 015 + cross-tenant E2E; deploy the new map-buddy endpoints to Cloud Run; A6 dice live-smoke + Lockport data migration; C4 canary deploy + engine rollback.

*Detail on every completed increment is in the per-DIC Linear comments (commit-referenced) and the git log; the status map + Keystone section above are the orientation.*

## Working agreement (kept throughout)

Incremental never big-bang; keep PV + parcel-studio green at every step; AI proposes / human disposes (propose before implementing widely); verify on the live map; commit + Linear-comment per increment; flag provisional contracts (§4.10 YAGNI — v1 contracts will refactor as A6/A7 add real cases). Repo gotcha: edit the **top-level** `parcel-viewer/` checkout (the dice-brain submodule pin can lag).
