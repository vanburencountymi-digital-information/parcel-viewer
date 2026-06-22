# Parcel Viewer — Session Handoff

**Written:** 2026-06-22 · **For:** next session, another machine
**Repo:** github.com/vanburencountymi-digital-information/parcel-viewer

> Claude's persistent memory lives in `~/.claude` and is **machine-local** — it will NOT be on the other computer. This file + **Linear** (team DICELabs, project *Parcel Viewer*) are the portable context. Read this first, then `git fetch && git checkout` the branch below.

---

## TL;DR (2026-06-22 — switching machines)

Everything is **committed and pushed** — nothing left only on the old box. A batch of viewer work
sits on a branch awaiting a PR; the choropleth tile migration sits on its own branch. Both need PRs
opened on the new machine (`gh` CLI was not installed here). A Linear **project status update** mirrors
this file.

## Where the code is

| Repo | Branch | State |
|---|---|---|
| `parcel-viewer` | `geraldhappel/session-2026-06-22-viewer-batch` | pushed; **PR not yet opened** |
| `county-data-services` | `geraldhappel/dic-527-parcel-tiles-assessing-fields` | pushed (migration 010); **PR not yet opened** |

Open the parcel-viewer PR here:
https://github.com/vanburencountymi-digital-information/parcel-viewer/pull/new/geraldhappel/session-2026-06-22-viewer-batch

The parcel-viewer work spans many DICs **interleaved across shared files** (`map.js`, `parcels.py`,
`vanburen.json`), so it landed as **one batched commit** rather than per-DIC. The commit body enumerates
the issues.

## Shipped this session (code-complete on the branch)

- **DIC-515** Reactive overlay pulse — `PS_pulseOverlay` + MapBuddy `pulse_layer` tool.
- **DIC-517** County-layer click-identify — query PostGIS vector layers on click (`wms-feature-info.js`).
- **DIC-525** Graceful "service not currently available" for down WMS/tile overlays (`overlay-layers.js`).
- **DIC-526** Aerial over VBC → switched to **Esri World Imagery**; `/aerial/{z}/{y}/{x}` route; `raster-fade-duration:0`.
- **DIC-527** Choropleth views (property class / TMV-per-acre / school district / plain) on the Parcels
  control + parcel-class legend nested under Parcels. Currently runs on the **feature-state** engine.
- **DIC-528** Performance (*ongoing requirement*): gzip, `/aerial` proxy_cache (7d), tile `max-age=300`,
  viewport-coverage skip on index refresh, `maxParallelImageRequests:32`, reduce-detail-during-motion,
  basemap hidden under aerial.
- **DIC-327** MapBuddy live layer-state awareness — `layer-registry.js` + `PS_LAYER_REGISTRY` snapshot
  into MapState (`agent.py` / `main.py` / `map-buddy.js`).
- **DIC-529** Hints — onboarding + contextual pill rail, dismissible, cookie-persisted (default **off**),
  settings toggle/reset, "show me where" spotlight coachmark.
- **DIC-533 / DIC-534** Street View — snap to address point (fallback nearest road) facing the structure;
  in-panel Google Maps Embed iframe via `COUNTY.integrations.googleMapsEmbedKey` + admin-console field +
  "Open in Google Maps" link.

## Pending — do on the new machine, in order

1. **Open + merge both PRs** (parcel-viewer batch + county-data-services migration 010).
2. **MapBuddy Cloud Run redeploy** (DIC-452) to activate `pulse_layer` (DIC-515) and layer awareness
   (DIC-327) — these are deploy-gated and inert until then.
3. **After migration 010 merges + run + Martin restart** → flip DIC-527 choropleth views from
   `engine:"feature-state"` to `engine:"tile"` (faster GPU paint; assessing fields then live in the tiles).
4. **Provision the Google Maps Embed key** in the Admin Console (DIC-534) so Street View embeds resolve.

## New backlog captured this session (planning only, no code)

- **DIC-535** — expose remaining Parcel Viewer tools to AI.
- **DIC-536** — Epic: *Analysis workflows* (answer local-gov questions across many parcels).
  Children: **537** foundation · **538** notification/adjacent-owner lists · **539** area/district summary ·
  **540** constraint & suitability scan · **541** year-over-year value change · **542** site selection ·
  **543** corridor · **544** temporal/what-changed · **545** data-gated (comps / zoning / delinquency).
  Recommended first build: **537 → 538/539** (highest value, no new data).
- Linear docs: *Map Buddy — AI capabilities reference* and *Analysis workflows — vision & catalog*.

---

## Run locally (still current)

`.env` lives in repo root (gitignored; Cloud SQL at `34.170.241.253` — **the new machine's IP must be
allowlisted** on the instance's authorized networks before the stack can reach the DB). Slim stack:
```
docker compose -f infra/docker-compose.viewer.yml --env-file .env up -d --build --no-deps api martin web
```
- Viewer: **http://127.0.0.1:8080/demo/** · Admin Console: **http://127.0.0.1:8080/admin/** (also via Settings → "Staff sign-in / Admin").
- **Use `127.0.0.1`, not `localhost`** — `localhost`→`::1` can hit a stale WSL instance; `127.0.0.1` forces the Docker container.

**Gotchas (these bit us before):**
- **`api` is NOT bind-mounted** — rebuild it (`--build api`) after any Python edit *or* after changing
  `vanburen.json` (the manifest is baked into the image; `/config`/`/config.js` won't update otherwise).
- `/api/config.js` (from `backend/parcel_viewer/county_configs/vanburen.json`) **overrides** the baked
  `frontend/public/js/county-config.js` — **edit both** when changing config the viewer reads.
- Frontend (`frontend/public/**`, `demo/**`, `admin/**`) **is** bind-mounted (live), but **nginx caches
  JS/CSS** — hard-refresh or `?v=` bust. Map handle is `window.PS_MAP`.
- **Browser verification:** the **Claude Preview MCP** needs port 8080, which Docker holds — free it with
  `docker stop infra-web-1`, then `preview_start parcel-viewer`. Restore detached with `up -d` when done.
- **Branch discipline:** the Admin Console's nginx route + compose mount live in `infra/` — checking out a
  branch off an older `main` and rebuilding `web` can 404 `/admin/`.

---

*Durable state = this file + the branches above + Linear (project *Parcel Viewer*, status update 2026-06-22).
Prior session's detail (2026-06-18, PRs #11–#14, per-layer styling architecture) is in git history at `a13bc9f`.*
