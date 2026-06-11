# Parcel Viewer

Reusable read-only parcel map for Van Buren County (and other PostGIS-backed county apps).

Includes MapLibre vector tiles (Martin), parcel search/selection, property info panel, regulatory overlays, parcel labels, drawing tools, and measurement tools.

**Parcel Studio** ([parcel-studio](https://github.com/vanburencountymi-digital-information/parcel-studio)) consumes this project as a git submodule and adds COGO traverse, split/merge, auth, and write paths.

## Prerequisites

- PostGIS with `geo.parcel_geometry`, `assessing.vbc_parcels`, and `geo.parcel_tiles()` (see [county-data-services](https://github.com/vanburencountymi-digital-information/county-data-services))
- Docker (recommended for full-stack local/prod deploy)
- Python 3.11+ (optional, for API hot-reload dev)

## Repo layout

| Path | Contents |
|------|----------|
| `frontend/public/js/` | MapLibre IIFE modules (`PS_MAP`, `PS_DRAWING_TOOLS`, …) |
| `frontend/public/css/` | Shared map styles |
| `backend/parcel_viewer/` | Importable read-only FastAPI package |
| `backend/app/main.py` | Standalone read-only API entrypoint |
| `demo/index.html` | Standalone demo (Layers \| Select \| Draw \| Measure) |
| `infra/compose.ps1` | Docker compose wrapper with preflight checks |
| `infra/docker-compose.viewer.yml` | api + martin + nginx stack |
| `docs/HANDOFF.md` | Deployment checklist, GCP notes, smoke tests |

## Deployment (standalone)

No frontend build step — nginx serves static JS/CSS directly.

```powershell
git clone https://github.com/vanburencountymi-digital-information/parcel-viewer.git
cd parcel-viewer
cp .env.example .env          # fill PV_DATABASE_URL, MARTIN_DATABASE_URL
.\infra\compose.ps1 up --build -d
```

Open http://localhost:8080 → `/demo/`

Stop:

```powershell
.\infra\compose.ps1 down
```

Full checklist, GCP steps, and smoke tests: [`docs/HANDOFF.md`](docs/HANDOFF.md).

### What runs in Docker

| Service | Role |
|---------|------|
| **web** (nginx) | Serves `demo/` and `frontend/public/`; proxies `/api` and `/tiles` |
| **api** | FastAPI read API (`parcel_viewer` package) |
| **martin** | Vector tiles from `geo.parcel_tiles()` |

`compose.ps1` fails fast if `.env`, map JS, demo HTML, Martin config, or the Python package is missing.

### Environment variables

| Variable | Purpose |
|----------|---------|
| `PV_DATABASE_URL` | Read API → PostGIS (falls back to `PS_DATABASE_URL`) |
| `MARTIN_DATABASE_URL` | Martin → PostGIS (`martin_ro`) |
| `PV_HTTP_PORT` | Host port (default `8080`) |

## Local development (hot reload)

For API-only iteration:

```powershell
cp .env.example .env
cd backend
python -m venv .venv; .venv\Scripts\activate
pip install -r requirements.txt
$env:PYTHONPATH = (Get-Location).Path
uvicorn app.main:app --reload --port 8000
```

Martin (separate terminal, from repo root):

```powershell
docker run -p 3000:3000 --env-file .env `
  -v ${PWD}/infra/martin/martin.yaml:/config/martin.yaml:ro `
  ghcr.io/maplibre/martin:1.10.1 --config /config/martin.yaml
```

For a **working map in the browser**, use the Docker stack (`.\infra\compose.ps1 up --build -d`). A plain static file server (`npx serve`) does not proxy `/api` or `/tiles`.

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

## License

Internal — Van Buren County Digital Information.
