# Parcel Viewer — Session Handoff

**Written:** 2026-06-17 (end of day) · **For:** next session on another machine, 2026-06-18
**Repo:** github.com/vanburencountymi-digital-information/parcel-viewer · **Branch:** `main` · **HEAD:** `d6947b6`

> Claude's persistent memory lives in `~/.claude` and is **machine-local** — it will NOT be on the other computer. This file + **Linear** (project *Parcel Viewer — Admin Console*) are the portable context. Read this first, then `git pull`.

---

## TL;DR

Today was the **Admin Console** (config-as-data control plane so the viewer scales to new counties without a developer). Built end to end and all merged to `main`; tree is clean and pushed.

- **Read side complete:** admin SPA shell + runtime `GET /config` API + all **5 read-only modules** (County, Intelligence, Styling, Data & Layers, Access & Ops).
- **Writable store built (without Drake):** `backend/parcel_viewer/config_store.py` (append-only versions + single draft; SQLite dev / Postgres prod, dialect from DSN) + write endpoints in `backend/app/main.py` (draft/publish/versions/rollback, interim `X-Admin-Token`) + `backend/migrations/0001_config_store.sql` (isolated `config` schema + least-priv `pv_writer` role).
- **Three modules now editable** (draft → publish → live `/config` → version history + rollback): **County**, **Styling** (`718d368`), **Data & Layers** (`d6947b6`).
- **Viewer consumes styling config** (`6c2072a`): color scheme + theme + parcel paint now come from `COUNTY.styling` (proven live: scheme change recolors the whole UI).

Editing is **dormant-safe**: with no writer DSN set, the public read path falls back to the baked manifest and writes return 503. It goes live only after prod provisioning (Drake — see below).

---

## Shipped today (all merged to `main`)

| Area | What | Commit |
|------|------|--------|
| Console shell | Admin SPA under `admin/` (registry + read-only County) | merged earlier |
| Runtime config API | `GET /config` + `GET /config.js` from `county_configs/vanburen.json` | merged earlier |
| Writable store | `config_store.py` + write endpoints + migration + editable County | `a3b3321` |
| Read-only modules | Intelligence, Styling, Data & Layers, Access & Ops | merged earlier |
| Viewer ← styling | `map.js` / `admin-menu.js` read `COUNTY.styling` | `6c2072a` |
| **Editable Styling** | scheme picker, theme/basemap, parcel color pickers, labels | `718d368` |
| **Editable Data & Layers** | PostGIS layers + tile server + data sources (WMS read-only) | `d6947b6` |

**Reusable edit infra** (in `admin/js/admin.js`): one delegated `wireEditHost` listener dispatches to the active module via `_active`/`activeRenderer()`; supports `data-path` inputs (`str`/`num`/`bool`/`json`), `[data-act]` (edit/save/publish/cancel/history), `[data-rollback]`, `[data-scheme-pick]`, and array `[data-add]`/`[data-remove]` with `getPath` + per-path `ADD_TEMPLATES`. **Intelligence and Access & Ops can be made editable with the same wiring** — that's the cheapest next win.

**Key decision (2026-06-17): WMS/raster overlays are being phased out — PostGIS (vector) layers are the editable focus.** The Data & Layers module reflects this: PostGIS layers are add/edit/removable; WMS/raster render read-only under a "being phased out" heading.

**Verification pattern used all day:** a throwaway store-backed mock (`_*.py` serving the admin static + `/api/config*` against a real `ConfigStore` on a temp SQLite db) driven through the preview browser; assert the edit→draft→publish→`/config` loop via DOM + API. Mocks are deleted after each verify (none committed). Note: screenshots on the cross-origin mock render unstyled (paint quirk) — trust DOM/API over the screenshot.

---

## What's next (in order of payoff)

1. **Make Intelligence + Access & Ops editable** — wiring is ready; just give their render fns edit mode like Styling/Data.
2. **Choropleth by attribute** (editable breaks + palette) + live sandboxed preview — the rest of the Styling epic **DIC-460**.
3. **Data ingestion loader** (**DIC-461**, the heavy build): upload (shp/GeoJSON/GeoPackage/FileGDB) → field-map → CRS/`ST_IsValid` validate → stage→atomic publish (versioned) → async job runner → Martin tile refresh. A sub-project on its own.
4. **Wire the viewer to consume `layers`/`labels` config** (it consumes `styling` already; overlays/labels still partly hardcoded — needs `overlay-layers.js` refactor).

## Parked / Drake-dependent

- **DIC-463 auth** — passwordless **magic-link per the DICE standard** (from the `dice-portal` repo: Brevo magic link + HMAC session cookies + `core.people` identity + `dice_platform_admin` cap), **NOT Google SSO**. Parked while Drake rethinks auth. Interim `X-Admin-Token` guards writes until then.
- **DIC-400 / DIC-464 prod provisioning** — the only truly Drake-owned piece. Runbook: `docs/admin-console-provisioning.md` (run migration, set `pv_writer` password + Secret Manager, set `PV_WRITER_DATABASE_URL` + `PV_ADMIN_TOKEN`, redeploy; ~15 min).
- **DIC-452** — MapBuddy Cloud Run redeploy (still pending from yesterday; blocks the explainer `/explain` + macro palette going live).

**Not yet verified:** the Postgres path + FastAPI endpoints against a live DB (no fastapi/PG in the dev shell — exercised only via the SQLite store + mocks).

---

## How to run locally (on the new machine)

1. **Recreate `.env`** in the repo root (gitignored — does NOT travel with the repo). Two DSNs (Cloud SQL at `34.170.241.253`):
   ```
   PV_DATABASE_URL=postgresql://parcel_studio_app:...@34.170.241.253:5432/postgres?sslmode=require
   MARTIN_DATABASE_URL=postgresql://martin_ro:...@34.170.241.253:5432/postgres?sslmode=require
   PV_MARTIN_PUBLIC_URL=/tiles
   PV_HTTP_PORT=8080
   ```
   (For the admin write path, also set `PV_WRITER_DATABASE_URL` — `sqlite:///./temp/config.db` for local, or the prod writer DSN — and `PV_ADMIN_TOKEN`. Unset = read-only/baked fallback.)
2. **Allowlist the new machine's public IP** on the Cloud SQL instance (Drake / DIC-311) — otherwise `api`/`martin` can't reach the DB.
3. Bring up the **slim stack** (skips the local map-buddy container — MapBuddy uses Cloud Run):
   ```
   docker compose -f infra/docker-compose.viewer.yml --env-file .env up -d --build --no-deps api martin web
   ```
4. Open **http://localhost:8080** → `/demo/`. The **admin console is at `/admin/`** (also reachable via a discreet "Staff sign-in / Admin" link in the viewer's Settings).

**Gotchas (these bit us):**
- **nginx caches JS/CSS** — hard-refresh (Ctrl+Shift+R) or `?v=` after edits. Frontend (`frontend/public/**`, `demo/**`, `admin/**`, `map-buddy/**`) is bind-mounted (live on reload); the **`api` and `map-buddy` backends do NOT auto-reload reliably on Docker Desktop** — restart the container after Python edits.
- **Browser caches `county-config.js`** — the console reads it (until `/config` is wired everywhere); hard-refresh to see manifest changes.
- If you see stale assets, try **`127.0.0.1:8080`** and check for a second server squatting the port.
- **MapBuddy on localhost → Cloud Run** by design; the local map-buddy container has no `ANTHROPIC_API_KEY`, so chat needs the redeploy/key — only deterministic endpoints work locally.

---

*Read-only console + writable store + 3 editable modules landed 2026-06-17. Durable state = this file + `main` + the Linear project (epics DIC-457–462, with "done/left" comments on DIC-460 & DIC-461).*
