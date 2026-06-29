# Parcel Viewer

Public-facing, read-only parcel map for Van Buren County (and other PostGIS-backed county deployments). Tiles come from Martin, the read API from a FastAPI backend, and an AI assistant (Map Buddy) runs as a separate Cloud Run microservice.

**Parcel Studio** ([parcel-studio](https://github.com/vanburencountymi-digital-information/parcel-studio)) consumes this repo as a git submodule and adds COGO traverse, split/merge, auth, and write paths.

---

## Services at a glance

| Service | Where | What it does |
|---------|-------|--------------|
| **api** | `backend/` | FastAPI read-only parcel API (search, parcel records, config) |
| **martin** | Docker image | Vector tile server — serves `geo.parcel_tiles()` as MVT |
| **web** (nginx) | `infra/nginx.viewer.conf` | Serves static JS/CSS; proxies `/api` → api, `/tiles` → martin, `/map-buddy` → Map Buddy |
| **Map Buddy** | `map-buddy/` | AI assistant microservice — deployed independently to Cloud Run |

The viewer stack (api + martin + nginx) and Map Buddy are **two separate deployables**. The viewer works without Map Buddy; AI features degrade gracefully when Map Buddy is unreachable or the key is missing.

---

## Prerequisites

- PostGIS with `geo.parcel_geometry`, `assessing.vbc_parcels`, and `geo.parcel_tiles()` (see [county-data-services](https://github.com/vanburencountymi-digital-information/county-data-services))
- Docker (for the full viewer stack)
- Python 3.11+ (optional, for API hot-reload dev)
- A GCP project with Cloud Run and Artifact Registry enabled (for Map Buddy)

---

## Repo layout

| Path | Contents |
|------|----------|
| `frontend/public/js/` | Vanilla JS IIFE modules — map, drawing, overlay layers, AI UI |
| `frontend/public/css/` | Shared map styles |
| `backend/parcel_viewer/` | Importable read-only FastAPI package |
| `backend/app/main.py` | Standalone read-only API entrypoint |
| `map-buddy/backend/` | Map Buddy FastAPI microservice |
| `map-buddy/js/map-buddy.js` | Browser client — SSE stream consumer, command dispatcher |
| `map-buddy/css/map-buddy.css` | Map Buddy panel styles |
| `map-buddy/deploy.sh` | Cloud Run build + deploy script |
| `engine/` | ISV source-agnostic capability engine + eval harness (see below) |
| `admin/` | Operator admin console (theme management, config) |
| `demo/index.html` | Standalone demo (Layers \| Select \| Draw \| Measure) |
| `infra/compose.ps1` | Docker compose wrapper with preflight checks |
| `infra/docker-compose.viewer.yml` | api + martin + nginx stack |
| `infra/DEPLOY-CHECKLIST.md` | Pre-launch checklist and smoke tests |
| `tools/a11y-proxy.py` | Accessibility audit proxy |

---

## Viewer stack — local development

No frontend build step. nginx serves static JS/CSS directly.

```powershell
git clone https://github.com/vanburencountymi-digital-information/parcel-viewer.git
cd parcel-viewer
cp .env.example .env          # fill PV_DATABASE_URL and MARTIN_DATABASE_URL
.\infra\compose.ps1 up --build -d
```

Open `http://localhost:8080/demo/`. Stop with `.\infra\compose.ps1 down`.

### What runs in Docker

| Service | Role |
|---------|------|
| **web** (nginx) | Static assets + `/api` and `/tiles` proxy |
| **api** | FastAPI parcel read API |
| **martin** | Vector tiles from `geo.parcel_tiles()` |

`compose.ps1` fails fast if `.env`, map JS, demo HTML, Martin config, or the Python package is missing.

### API-only hot reload (without Docker)

```powershell
cp .env.example .env
cd backend
python -m venv .venv; .venv\Scripts\activate
pip install -r requirements.txt
$env:PYTHONPATH = (Get-Location).Path
uvicorn app.main:app --reload --port 8000
```

Martin in a separate terminal:

```powershell
docker run -p 3000:3000 --env-file .env `
  -v ${PWD}/infra/martin/martin.yaml:/config/martin.yaml:ro `
  ghcr.io/maplibre/martin:1.10.1 --config /config/martin.yaml
```

For a **working map in the browser**, use the full Docker stack — `npx serve` won't proxy `/api` or `/tiles`.

### Viewer environment variables

| Variable | Purpose |
|----------|---------|
| `PV_DATABASE_URL` | Read API → PostGIS (falls back to `PS_DATABASE_URL`) |
| `MARTIN_DATABASE_URL` | Martin → PostGIS (`martin_ro` role) |
| `PV_HTTP_PORT` | Host port (default `8080`) |

---

## Map Buddy — AI assistant microservice

Map Buddy is a standalone FastAPI service (`map-buddy/backend/`) that wraps the Anthropic API. The viewer streams commands from it over SSE and executes them in the browser — the model drives the map by calling tools, and the browser resolves geometry and applies the effects.

The key design constraint: **the model never originates authoritative facts.** Every AI endpoint receives pre-computed, deterministic figures from the caller and only narrates or characterizes them. The frontend always has a working non-AI path.

### Deploying Map Buddy

```bash
bash map-buddy/deploy.sh
```

This builds the Docker image, pushes it to Artifact Registry, and deploys to Cloud Run (`core-db-475718 / us-central1`). The service URL is printed at the end — update it in three places if it changes (see [infra/DEPLOY-CHECKLIST.md](infra/DEPLOY-CHECKLIST.md)).

The viewer is configured to reach Map Buddy via `COUNTY.endpoints.mapBuddy` in `frontend/public/js/county-config.js`, `backend/parcel_viewer/county_configs/vanburen.json`, and `engine/themes/vanburen.json`.

### Map Buddy API endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/health` | Liveness probe |
| `GET` | `/status` | AI availability, cache stats, per-tenant quota counts |
| `GET` | `/config` | Version + capability list |
| `POST` | `/chat` | SSE chat stream — model calls tools, backend streams `{type, ...}` events |
| `POST` | `/explain` | Structured assessment or tax-description explainer (grounded, cached) |
| `POST` | `/autoconfigure` | AI rationale + suggestions over a deterministic theme manifest draft |
| `POST` | `/describe-cohort` | Plain-language character read over a Neighborhood Profile's computed aggregates |
| `POST` | `/judge` | LLM grounding gate — verifies AI output against deterministic truth (CI/pre-ship use) |
| `POST` | `/kb/resolve` | Resolve a §6.4 citation envelope against the County Knowledge Base |
| `GET` | `/explainers` | Catalog of explainer plugins (prompt + injected context blocks) |
| `GET` | `/workflows` | Catalog of deterministic macro workflows |
| `POST` | `/workflow` | Expand a workflow into map commands without a model round-trip |

**`POST /chat` event types** (SSE stream):

| `type` | Payload | Meaning |
|--------|---------|---------|
| `status` | `{message}` | In-progress status ("Thinking…", "Working on it…") |
| `done` | `{response_text, commands, citations}` | Final turn; `commands` are forwarded to `_runCommands` in the browser |
| `error` | `{message}` | Model or network failure |

**`commands`** are `{type, payload}` objects where `type` maps 1:1 to a handler in `map-buddy/js/map-buddy.js`. The model calls tools server-side; this file executes them in the browser.

### Chat tool categories

The model has ~40 tools organized into groups:

| Group | Tools |
|-------|-------|
| **Camera** | `fly_to_parcel`, `cinematic_fly_to_parcel`, `fly_to_coordinates`, `zoom_to`, `zoom_by`, `set_pitch`, `set_bearing`, `reset_north`, `fit_map_to_parcel`, `fit_to_annotations` |
| **Selection** | `select_parcel`, `highlight_parcel` |
| **Layers** | `set_layer_visibility`, `pulse_layer` |
| **Drawing** | `draw_point`, `draw_line`, `draw_polygon`, `draw_circle`, `label_point`, `label_parcel_centroid`, `draw_parcel_buffer`, `place_structure_in_parcel`, `clear_annotations` |
| **Measurement** | `measure_parcel`, `measure_area`, `measure_distance` |
| **Data lookups** | `search_parcels`, `get_parcel_info`, `get_environmental_info` (FEMA/NWI/SSURGO queried server-side) |
| **Interface** | `set_theme`, `set_basemap`, `set_base_layer`, `set_accessibility`, `set_panel_transparency`, `open_panel`, `set_area_units`, `set_coordinate_format`, `bookmark_current` |
| **Viewer tools** | `set_parcel_labels`, `dimension_parcel`, `activate_draw_tool`, `undo`, `redo`, `open_tool`, `compare_parcels`, `describe_neighborhood`, `map_tour` |
| **Workflows** | `run_workflow` (deterministic macro expansion — no extra model round-trip) |
| **UX** | `suggest_actions` (proactive next-step chips) |

Data-lookup tools (`search_parcels`, `get_parcel_info`, `get_environmental_info`) are resolved server-side and the real result is fed back into the model loop. All other tool calls produce a synthetic acknowledgement; the browser does the actual work.

### Workflow macros

Three built-in workflows expand a single `run_workflow` call into a fixed sequence of map commands, optionally with a server-side environmental lookup (FEMA/NWI/SSURGO):

| ID | What it does |
|----|-------------|
| `analyze_parcel` | Select + fly to parcel, turn on flood/wetlands, measure, return env data |
| `check_buildability` | Select + fly, dimension sides, draw inward setback ring (default 30 ft), conditionally add flood layer if SFHA |
| `risk_overview` | Select + fly, turn on flood/wetlands/soils, return env data |

Add a new macro by adding an entry to `WORKFLOWS` in `map-buddy/backend/agent.py` — the `/workflows` catalog and `run_workflow` tool description update automatically.

### Explainer profiles

`POST /explain` supports two topics, each with its own system prompt and injected reference corpus:

| Topic | What it narrates | Injected corpus |
|-------|-----------------|-----------------|
| `assessment` | Assessed value, taxable value, Proposal A cap, PRE | Curated Michigan property-tax statutes (MCL citations only) |
| `tax_description` | Legal description structure and terminology | Survey/PLSS abbreviation glossary |

Both use forced tool calls (`render_explanation`) so the frontend always gets a stable `{summary, sections, glossary, statutes, disclaimer}` shape.

### Cross-cutting concerns (all AI endpoints)

- **Result cache** (C3): tenant-scoped in-process LRU. Same parcel explained twice doesn't pay twice. Cache stats visible at `GET /status`.
- **Per-tenant quota** (C4): configurable per-tenant call budget. Quota-exceeded returns `{ok: false, degraded: true}` so the frontend falls back to the non-AI path.
- **ANTHROPIC_API_KEY gate**: if the key is absent, all AI endpoints return `{ok: false}` immediately. The `/kb/resolve` endpoint is NOT gated — citations must work without AI.
- **Rate limiting**: `slowapi` per-IP; configurable via `MAP_BUDDY_RATE_LIMIT` env var (default 120/minute).

### Map Buddy environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `ANTHROPIC_API_KEY` | — | Required for all AI endpoints |
| `PARCEL_API_BASE` | `http://api:8000` | Parcel API for server-side tool resolution |
| `ALLOWED_ORIGINS` | localhost variants | CORS allowed origins |
| `MAP_BUDDY_RATE_LIMIT` | `120/minute` | Per-IP rate limit |
| `MAP_BUDDY_MODEL` | `claude-sonnet-4-6` | Model for chat and cohort narration |
| `EXPLAIN_MODEL` | `MAP_BUDDY_MODEL` | Model for `/explain` |
| `AUTOCONFIGURE_MODEL` | `claude-haiku-4-5` | Model for `/autoconfigure` |
| `COHORT_NARRATE_MODEL` | `MAP_BUDDY_MODEL` | Model for `/describe-cohort` |
| `JUDGE_MODEL` | `claude-haiku-4-5` | Model for `/judge` |
| `MAP_BUDDY_MAX_TOKENS` | `2048` | Max tokens per chat turn |
| `MAP_BUDDY_MAX_ITERS` | `6` | Max tool-call iterations per chat request |
| `KB_BACKEND` | `fixture` | `fixture` = local JSON, `dice` = live db-dice knowledge.chunks |

---

## Engine — ISV capability contract (`engine/`)

The `engine/` directory is the **source-agnostic ISV engine**: a capability contract and CI eval harness shared across viewer features. It contains no domain vocabulary — the word "parcel" does not appear in engine code, enforced by `engine-smoke.test.js`.

### Capability contract (A1)

One invocation seam:

```js
ISV.invoke(capabilityId, typedInput, { ai }) ->
  { capability, facts, provenance, narration, meta }
```

Register a capability:

```js
ISV.register({
  id,         // string
  aiMode,     // 'no-ai' | 'ai-optional' | 'ai-required'
  core,       // (typedInput) -> { facts, provenance }  — PURE, no model
  narrate?,   // (facts, provenance, ctx) -> structuredOutput  — AI layer
})
```

**Two front doors, one core**: the viewer UI supplies `typedInput` directly (AI-off path); Map Buddy resolves the same `typedInput` from natural language and calls the same `core` as a tool. AI is just another caller over the deterministic result.

### Invariants enforced in code

| Invariant | What it means |
|-----------|---------------|
| Source-agnostic | No domain noun in engine code; `engine-smoke.test.js` greps for it |
| AI never in the critical path | `core()` is the only thing on the data path; `narrate()` is never called AI-off |
| Facts-parity (§4.6) | `facts` + `provenance` are identical AI-on and AI-off; only `narration` differs |
| Honest provenance | Every provenance entry is a citation envelope `{source_id, anchor, span, state}` with state `resolves \| coarse \| none` |
| Automatic fallback | A throwing/absent narrator degrades to AI-off instead of erroring |

### Registered capabilities

| ID | AI mode | What it computes |
|----|---------|-----------------|
| `explainer` | `ai-optional` | Property assessment figures; provenance = curated MI statute corpus |
| `ledger` | `no-ai` | Parcel event history; provenance = native `source_document` per event |
| `cohort-analyze` | `ai-optional` | Neighborhood/area profile aggregates |
| `theme-composer` | `ai-optional` | Theme manifest assembly from console config |

The capability catalog (`engine/capability-catalog.js`) is the vocabulary of all capabilities a theme can enable, each with a default AI tri-state and disclosure level (`basic | advanced | hidden`). The manifest assembler (`engine/manifest-assemble.js`) reads the catalog to build a versioned, exportable theme manifest from the admin console's editor state.

### Eval harness (A2)

Zero third-party dependencies. Run it:

```bash
bash engine/run-harness.sh
# or individually:
cd engine && node --test                          # JS tests
cd engine && python -m unittest test.run_explain_contract_test -v  # Python: explainer contract
```

CI: `.github/workflows/isv-harness.yml` (Node 20 + Python 3.11). No live model, no secrets.

| Test | Proves |
|------|--------|
| `explainer.core.test.js` | Deterministic facts; figures restated never originated |
| `ledger.core.test.js` | Event normalization; native provenance; honest `none` |
| `facts-parity.test.js` | §4.6 — facts/provenance identical AI-on/off |
| `ai-boundary.test.js` | §4.3 — `narrate()` never runs AI-off |
| `manifest-schema.test.js` | §5.2 — invalid manifest rejected; AI tri-state enum |
| `engine-smoke.test.js` | §4.1 — no domain noun in engine code |
| `run_explain_contract_test.py` | Forced `render_explanation` tool call; grounded on curated corpus |

---

## Public JS extension API

Configure before loading scripts:

```javascript
window.PS_CONFIG = {
  API_BASE: '/api',
  MARTIN_URL: '/tiles',
  WS_URL: '',  // optional; empty disables WebSocket tile refresh
};
```

Hooks and helpers exposed on `window`:

| Symbol | Purpose |
|--------|---------|
| `PS_MAP` | MapLibre map instance |
| `PS_STATE.parcel` | Currently selected parcel summary |
| `PS_onParcelSelect` | Callback `(parcel) => void` — set before map.js loads |
| `PS_selectParcel(pin)` | Programmatic selection by parcel number |
| `PS_selectParcelById(id)` | Programmatic selection by database id |
| `PS_refreshParcelTiles()` | Force MVT tile reload |
| `PS_MAP_PANEL` | Map control panel API (tabs, layers, selection) |
| `PS_DRAWING_TOOLS` | Drawing tools module |
| `PS_MEASURE_TOOL` | Measurement tools module |
| `ISV` | Engine capability registry (browser global) |

---

## Using as a git submodule

In a consuming app (e.g. Parcel Studio):

```powershell
git submodule add https://github.com/vanburencountymi-digital-information/parcel-viewer.git packages/parcel-viewer
git submodule update --init --recursive
```

Load assets from `/parcel-viewer/js/...` (see Parcel Studio `frontend/vite.config.js`).

**Bump viewer version in Studio:**

```powershell
cd packages/parcel-viewer
git checkout main
git pull
cd ../..
git add packages/parcel-viewer
git commit -m "Bump parcel-viewer submodule"
```

---

## License

Internal — Van Buren County Digital Information.
