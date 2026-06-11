# Parcel Viewer — handoff notes

Last updated: 2026-06-11. Standalone read-only parcel map (no auth, no writes).

## Repos

| Repo | Role |
|------|------|
| `parcel-viewer/` | This repo — map UI, read API, Martin config, demo app |
| `parcel-studio/` | Full editing app — consumes this repo as `packages/parcel-viewer` submodule |
| `county-data-services/` | PostGIS schema owner — migrations 001–009, `geo.parcel_tiles()` |

Schema changes always go through `county-data-services`. This repo assumes 001–009 are applied.

## What this deploys

```
Browser → nginx :8080
            /demo/              demo/index.html + /frontend/public/ JS/CSS
            /api/               FastAPI read API (parcel_viewer)
            /tiles/             Martin → geo.parcel_tiles()
          PostGIS (GCP)         geo.parcel_geometry, assessing.vbc_parcels
```

No JWT, no split/merge, no COGO commit, no WebSocket tile invalidation.

## Deployment checklist

### 1. Clone

```powershell
git clone https://github.com/vanburencountymi-digital-information/parcel-viewer.git
cd parcel-viewer
```

No submodules required.

### 2. Secrets

```powershell
cp .env.example .env
```

| Variable | Purpose |
|----------|---------|
| `PV_DATABASE_URL` | FastAPI read API (e.g. `parcel_studio_app` or read-only user) |
| `MARTIN_DATABASE_URL` | Martin tile server (`martin_ro`) |
| `PV_HTTP_PORT` | Host port for nginx (default `8080`) |

You can copy DSN values from `parcel-studio/.env` — same PostGIS instance.

Also accepts `PS_DATABASE_URL` as a fallback for `PV_DATABASE_URL` (see `backend/parcel_viewer/config.py`).

### 3. Start stack

```powershell
.\infra\compose.ps1 up --build -d
```

Open http://localhost:8080 (redirects to `/demo/`).

Stop when done (frees Cloud SQL connections):

```powershell
.\infra\compose.ps1 down
```

`compose.ps1` validates `.env`, frontend assets, demo page, Martin config, and Python package before `up`/`build`.

### 4. Smoke test

- Map tiles render (parcels visible at zoom 11+)
- Search returns results
- Click parcel → info panel
- Layers tab → toggle aerial / overlays
- Draw and Measure tabs work

## Local development (hot reload)

Use Docker for the simplest full-stack test (checklist above). For frontend/backend iteration:

**Terminal 1 — API**

```powershell
cd backend
python -m venv .venv; .venv\Scripts\activate
pip install -r requirements.txt
$env:PYTHONPATH = (Get-Location).Path
uvicorn app.main:app --reload --port 8000
```

**Terminal 2 — Martin**

```powershell
docker run -p 3000:3000 --env-file .env `
  -v ${PWD}/infra/martin/martin.yaml:/config/martin.yaml:ro `
  ghcr.io/maplibre/martin:1.10.1 --config /config/martin.yaml
```

**Terminal 3 — Demo with proxy**

Plain `npx serve` does **not** proxy `/api` or `/tiles`. Options:

- **Recommended:** `.\infra\compose.ps1 up --build -d` (nginx handles routing)
- **Or** run only nginx from compose while iterating on API locally (advanced)

Do not expect a working map from `npx serve` alone.

## GCP / VM deployment

Same stack as local Docker:

1. GCE VM with Docker installed
2. `git clone` this repo
3. `.env` from Secret Manager or copy from parcel-studio (same DSNs minus JWT/operators)
4. `.\infra\compose.ps1 up --build -d`
5. HTTPS via load balancer, Caddy, or Cloudflare in front of the VM
6. Firewall: allow 443 (and 80 → redirect)

No frontend build step — nginx serves `frontend/public/` and `demo/` directly.

## Updating production

```powershell
git pull
.\infra\compose.ps1 up --build -d
```

Rebuilds `api` if the Python package changed. Static JS/CSS updates are picked up via volume mount (restart `web` or full `up -d`).

## Consumed by Parcel Studio

Parcel Studio embeds this repo as a git submodule and adds write paths on top. When viewer changes ship:

1. Push to `parcel-viewer` `main`
2. In `parcel-studio`: `cd packages/parcel-viewer && git pull`, bump submodule commit, rebuild frontend

See `parcel-studio/docs/HANDOFF.md` for the Studio-side workflow.

## Quick reference

| Item | Value |
|------|--------|
| GitHub | https://github.com/vanburencountymi-digital-information/parcel-viewer |
| Demo URL (local) | http://localhost:8080/demo/ |
| Martin tiles | `/tiles/parcel_tiles/{z}/{x}/{y}` |
| API health | http://localhost:8080/api/health |
| Compose wrapper | `infra/compose.ps1` |
| Martin image | `ghcr.io/maplibre/martin:1.10.1` |

## Known issues / follow-ups

- Demo HTML uses `/frontend/public/` paths — nginx aliases these; do not change without updating `infra/nginx.viewer.conf`.
- `style.css` includes some COGO/drawing rules shared with Studio — harmless for viewer-only deploy.
- Connection budget: stop compose when not developing (`.\infra\compose.ps1 down`) to free Cloud SQL slots.
