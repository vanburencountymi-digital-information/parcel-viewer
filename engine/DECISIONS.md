# ISV — Risk & Decisions Log (A1/A2 check-in, 2026-06-26)

Surfaced, not resolved. "AI proposes, human disposes" (§4.12) — including me.

## Resolved this pass (with your input)

| # | Decision | Choice |
|---|---|---|
| D1 | Contract + harness home | **In-repo `parcel-viewer/engine/`** (incremental; extract to a shared package once a 2nd viewer consumes it). |
| D2 | Harness runtime | **Node `node:test` (JS cores) + stdlib `unittest` (Python `run_explain`)**, one CI workflow, zero third-party deps. (You deferred this to me.) |
| D4 | ZIP `knowledge_chunks` embedding provider | **Keep OpenAI `text-embedding-3-small`** for A6. This preserves the current ZIP vector-search shape and keeps OpenAI as the known embedding dependency rather than re-embedding or replacing vector search during the rewrite. |
| D3 | AI-off explainer behavior | **Facts + curated statute links, no prose** (§4.5). Baked into the engine core's provenance + harness; UI surfacing is A7a (see O1). |
| D5 | C2 manifest validation engine | **Defer Ajv; ship migrate-on-load on the zero-dep validator** (`validate-manifest.js`). Pulling Ajv cuts against the zero-dep harness + no-build-tool frontend ethos; the JSON Schema (`schema/manifest.schema.json`) stays the source-of-truth doc. The Ajv swap is an isolated later decision that only touches `validate-manifest.js` — the `loadManifest()` seam contract is stable across it. |
| D7 | Parcel popup config (Phase 3) | **Manifest declares the §5 section-NAME list (`sources['parcels'].popup.sections`); the rich per-field config + JS formatters + the structurally-hardcoded render stay viewer-owned (`_PARCEL_INFO_SOURCE` / `_PARCEL_FORMATTERS` in `map.js`).** §5 models `popup.sections` as section-name strings; the viewer needs rich objects (label/field/format/tip/style per row) plus JS formatter functions (money/acres/class-display/AV-history-chart) that can't live in JSON, and the panel render is a fixed template with custom widgets (assessed-values table+chart, explain buttons) and interleaved dividers — NOT a list iteration. Migrating that into a manifest-driven render is a disproportionate, high-risk refactor of the most-used panel for little gain (the section set rarely varies per county). So: the COUNTY-DATA part already migrated — `idField` (Slice A) + the section-name list now carried onto the manifest (config-as-data, §5-complete, exposed as `PV_PARCEL_SOURCE.popupSections`); the presentation layer stays in the viewer. A future slice can make the render iterate the manifest section list if a county ever needs to reorder/hide sections. |
| D6 | WMS federated overlays (Phase 3) | **Stay module-owned in `overlay-layers.js`; NOT migrated into the per-county manifest.** Wetlands (USFWS), Flood (FEMA), Soils (USDA), Hillshade (AWS DEM), Contours (USGS 3DEP) are **federated external services with national datasets identical for every county** — their request mechanics (endpoint URL, WMS version, layer name, opacity, attribution, hillshade DEM treatment) are platform defaults, not per-county data (§12 treats external tiling/data as out of scope). Forcing them into each county manifest would duplicate the same national-dataset config across every tenant and conflate "platform-provided overlays" with "county data." The manifest still LISTS them (informational stubs from `COUNTY.layers.overlays`, for the layer panel + AI awareness); the module provides rendering. If a county ever needs to hide/relabel one, that LIST-level choice (not the federated mechanics) can become manifest-driven later. The vector overlays (Slices B2/C) ARE county data → migrated; WMS is not. |

## Vision-describe capability decisions (2026-06-27) — planning pass, see Linear DIC-555

| # | Decision | Choice |
|---|----------|--------|
| D8 | Vision-describe framing | **A G1 capability** (`view-describe`, `aiMode:'ai-optional'`, registered via `engine/capability.js`), packaged via the DIC-555 `MapVisualHost` plugin seam for host-agnostic capture. DIC-555 predates the contract (DIC-567); reconcile, don't fork. The capability gets facts-parity, AI tri-state, auto-fallback, §6.4 provenance, and C3/C5 governance for free. The 3 "rings" become capability increments. |
| D9 | The inverted shape (AI is the OUTPUT, not narration over facts) | **`core()` = deterministic "identify"** (§4.5) — a structured account of view state (layers on + normalized `kind`, focus feature + DB record, zoom/scale, bbox) + provenance (DB/layer-config). **`narrate()` = the vision call** over the captured image. AI-off → deterministic identify still renders (facts-parity holds at description-of-state level). This is what makes vision unique vs. explainer/ledger. |
| D10 | Honesty / provenance | Vision output has **no citable source** → §6.4 state `none` ("AI visual interpretation", never `resolves`). **No numbers from the model, ever** — acreage/dims/zoning/PRE come only from `core()` grounding; the model describes qualities, not quantities. Grounding-judge (DIC-586) gates that no number absent from grounding appears. (Liability point, DIC-388.) |
| D11 | Canvas capture | **On-demand offscreen render** when a description is requested — NOT global `preserveDrawingBuffer:true` (per-frame cost, violates §4 #9 performance-first). Hidden behind `MapVisualHost.captureImage()`. Amends DIC-388 req #5. |
| D12 | ADA role | Vision = **labeled enhancement, NEVER the compliance backbone**. The deterministic path (DIC-381/382/385 keyboard search → popup → live regions) carries WCAG; vision is opt-in, non-deterministic, may be AI-off → not certifiable. Build both the Map Buddy tool mount and the ADA "Describe this view" mount (aria-live). |

**OPEN (needs team — flagged, NOT decided): AI default ON.** Owner wants sessions to **start AI ON** with opt-out + a first-run pill. This **reverses §4 invariant #4 / DIC-571** ("default AI off/opt-in", chosen for cost/privacy/procurement). Platform-wide blast radius (explainers + Map Buddy + vision). Mechanism exists (`COUNTY.ai.defaultMode='on'`); recommend making it a **manifest field** so it's per-theme, pill shown when it resolves to `on`. Holding the flip + pill until confirmed. (Linear DIC-571 comment.)

## Open decisions — need the team (BLOCKING the work they gate)

| # | Decision | Why it's blocking | Options |
|---|---|---|---|
| **O1** | Engine-serving for the browser | the live `pv-explain.js` can't `require` `engine/` — nginx serves only `frontend/public`. Needed before A7a wires the live UI to the cores. | **(a) CHOSEN (provisional default, revisit at A7a):** add a volume + `location /engine/` mount so `engine/` stays the single canonical home. (b) relocate browser bundles under `frontend/public/js/engine/`. |

**A6-a RESOLVED (2026-06-26) → option (a): migrate ZIP DB into the DICE project.**
Drake migrated ZIP's `knowledge_chunks` → **`knowledge.chunks`** in db-dice
(`core-db-475718`): 657 rows, pgvector enabled, new `jurisdiction` column (default
`lockport-township`), `text`→`content`, `(section_id, jurisdiction)` unique
(`county-data-services` `39296c5`; DIC-570 comment). The **KnowledgeStore half is
unblocked** and now built (see Done). The **ParcelStore half stays blocked** — the
Lockport parcel geometry/assessment/zoning data is **not yet in db-dice**; Drake
deferred it pending a team DB-shape decision (`assessing.sjc_parcels` vs a generalized
`assessing.parcels` w/ county discriminator), a `zoning.parcel_zones` schema, and the
Lockport ETL from `repos/zip-poc/data/`.

O1 resolved to **(a)** — fully reversible (~2 infra lines + script-src paths; only one
consumer, no blast radius), revisit at A7a if it feels wrong. A6-b resolved to **keep
OpenAI `text-embedding-3-small`**.

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
`COUNTY`→`ctx.config`). Active viewer reads now route through `PS_CONTEXT.config`
with a `window.COUNTY` fallback across `map.js`, covered `pv-*` consumers
(`pv-explain`, `pv-doc`, `pv-feature-info`, `pv-ai-health`), and the layer/control
modules (`admin-menu`, `county-layers`, `pg-layers`, `overlay-layers`,
`wms-feature-info`, `layer-registry`). The remaining `window.COUNTY` writes/reads
are the config bootstrap/preview files plus fallback accessors. The `PS_STATE`
migration IS A4.

## In progress — A4 (SelectionManager, the keystone & riskiest)

**Slice 4 DONE** (commit pending): selection replacement paths in `map.js` now clear
selection highlights through the source-agnostic highlighter wrapper (`setFS`) via a
single `resetSelectionStorage()` helper, instead of bypassing it with direct
`map.setFeatureState` calls. Empty-selection paths now announce both selection and
active-feature clears on the bus. `showParcelAtIndex()` now routes active feature
changes through `PS_SELECTION.setActive(ref)` when the SelectionManager is present,
with the old bus emit as fallback. Parcel-studio globals remain intact:
`PS_STATE.parcel`, `PS_selectParcel*`, and `PS_onParcelSelect()` are still exposed.

**Slice 2 DONE** (commit pending): `engine/feature-highlight.js` — source-agnostic
MapLibre feature-state highlighter (`set(id,state)` + `bindActive(bus,{stateKey})`,
map injectable lazily). map.js's 5 inline `setFeatureState` sites now delegate to it via
a `setFS()` helper (behavior-identical, inline fallback so PV can't regress); source/
sourceLayer are config, removing that hardcoding (feeds A5). `clearSelectionAll()` now
emits `PS_SELECTION.clear()` → completes the bus stream with selection clears (slice 1
mirrored selects only). Unit-tested (`engine/test/feature-highlight.test.js`) + browser-
verified (highlighter drives feature-state off the live bus; clear emits null-ref). Caveat:
`PS_MAP` doesn't init in the static preview (no tiles), so the live on-map selection flow
needs the dockerized stack to runtime-verify; the map.js change is a behavior-identical
refactor (syntax-checked, fallback-guarded).

**Slice 3 DONE & verified on the REAL dockerized map** (commit pending): the info panel
is now event-driven — map.js emits `active-feature-changed` at the selection site and a
subscriber renders `showParcelInfo` (its internals unchanged; only WHO triggers it is
decoupled). map.js also drives `PS_SELECTION.select(ref)` explicitly → `selection-changed`.

**Bug found by live verification + fixed:** the slice-1 `PS_onParcelSelect` accessor
interception **infinitely recursed against hints.js** (which also wraps that hook) on the
real map — a regression invisible in the static preview. Replaced with explicit driving
from map.js; the interception is gone, so parcel-studio's `PS_onParcelSelect` is now
completely untouched (safer than before). Verified: 0 console errors across repeated
selects, panels render, selection/active events fire. Lesson: monkeypatching a shared
global is fragile; drive the bus explicitly.

**Tooling:** fixed a gzip bug in `tools/a11y-proxy.py` (it stripped `content-encoding`
but forwarded compressed bytes) so the preview can drive the full dockerized viewer
(8091 → docker 8080) — this is what made on-map verification possible.

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

## In progress — A5 (source abstraction)

**Slice 1 DONE** (commit pending): the live parcel info panel now renders both the
`Parcel` and `Owner` sections through the source-agnostic `ISV_POPUP` renderer, with
inline fallbacks preserved if the engine bundle is absent. `engine/popup.js` gained two
generic affordances needed by real panels: formatter context now receives the whole
feature/geometry, and configured rows may carry a `skipEmpty` hint. Custom parcel
sections that are richer than config (`Assessed Values` chart/actions, tax explainer
button) remain as-is for now.

**Slice 2 DONE** (commit pending): PostGIS vector overlays can now behave as
first-class selected/detail sources. `PV_FEATURE_INFO.select(source, feature)` renders
the shared info panel and emits source-aware `selection-changed` /
`active-feature-changed` events. `wms-feature-info.js` promotes clicked vector overlay
hits into that path and exposes `selectVectorFeatureAt(point)` so the parcel click
handler can give visible non-parcel sources precedence over parcel selection. WMS
raster overlays remain popup-based.

**Slice 3 DONE** (commit pending): the parcel panel's `Assessed Values` field
definitions (labels, source fields, tooltips, money/percent/TMV/history formatters)
now live in `_PARCEL_INFO_SOURCE` and flow through `ISV_POPUP.renderSections`. The
rich table/chart renderer remains viewer-specific, but it now consumes source-config
rows instead of hardcoding the field contract in the HTML build.

**Slice 4 DONE** (commit pending): `Tax Description` now also has its field contract
in `_PARCEL_INFO_SOURCE`, with a formatter that prefers `ps_legal_description` and
falls back to `legal_description`. The viewer keeps the tax-description explain button
and description styling, but the selected source config now owns which parcel field
feeds that detail section.

## Not started (next up)

A5 remaining sections/source-click wiring; A6 (gated on A6-a); B* (AI toggle /
Theme Composer); C* (hardening).
