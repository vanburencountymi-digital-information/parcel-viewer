# Parcel Viewer

Reusable read-only parcel map for Van Buren County (and other PostGIS-backed county apps).

Includes MapLibre vector tiles (Martin), parcel search/selection, property info panel, regulatory overlays, parcel labels, drawing tools, and measurement tools.

**Parcel Studio** (`parcel-studio` repo) consumes this project as a git submodule and adds COGO traverse, split/merge, auth, and write paths.

## Prerequisites

- PostGIS with `geo.parcel_geometry`, `assessing.vbc_parcels`, and `geo.parcel_tiles()` (see [county-data-services](https://github.com/vanburencountymi-digital-information/county-data-services))
- Node 20+ (optional, for static demo server)
- Python 3.11+

## Repo layout

| Path | Contents |
|------|----------|
| `frontend/public/js/` | MapLibre IIFE modules (`PS_MAP`, `PS_DRAWING_TOOLS`, …) |
| `frontend/public/css/` | Shared map styles |
| `backend/parcel_viewer/` | Importable read-only FastAPI package |
| `backend/app/main.py` | Standalone read-only API entrypoint |
| `infra/martin/` | Martin tile server config |
| `demo/index.html` | Standalone demo (Layers \| Select \| Draw \| Measure) |

## Local development (standalone)

```powershell
# 1. Environment (copy from parcel-studio .env or use read-only DB user)
cp .env.example .env

# 2. Backend (port 8000)
cd backend
python -m venv .venv; .venv\Scripts\activate
pip install -r requirements.txt
$env:PYTHONPATH = (Get-Location).Path
uvicorn app.main:app --reload --port 8000

# 3. Martin (port 3000)
docker run -p 3000:3000 --env-file ..\.env `
  -v ${PWD}\..\infra\martin\martin.yaml:/config/martin.yaml:ro `
  ghcr.io/maplibre/martin:1.10.1 --config /config/martin.yaml

# 4. Static demo (port 8080) — from repo root
npx --yes serve . -l 8080
# Open http://localhost:8080/demo/
```

Configure the demo to reach the API by proxying `/api` and `/tiles` in your static server, or run behind nginx (see `infra/docker-compose.viewer.yml`).

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

**Bump viewer version:**

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
