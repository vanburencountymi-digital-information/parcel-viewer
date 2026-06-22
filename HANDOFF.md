# Parcel Viewer — Session Handoff

**Written:** 2026-06-18 (end of day) · **For:** next session, another machine
**Repo:** github.com/vanburencountymi-digital-information/parcel-viewer · **Branch:** `main` · **HEAD:** `a13bc9f`

> Claude's persistent memory lives in `~/.claude` and is **machine-local** — it will NOT be on the other computer. This file + **Linear** (team DICELabs, project *Parcel Viewer*) are the portable context. Read this first, then `git pull`.

---

## TL;DR

Four PRs shipped and **all merged to `main`** (#11–#14); tree is clean. Theme of the day: finished the **Admin Console editing**, generalized **styling to per-layer**, and closed the one **launch blocker** that didn't need infra. Meanwhile **Drake made the deployment decision** (DIC-320) and stood up a launch path.

---

## Shipped this session (all on `main`)

| PR | Issue | What |
|----|-------|------|
| #11 | DIC-462 | **Access & Ops** module editable (draft→publish→rollback). Also fixed a `/config` **route collision** (a legacy `parcels` router `/config` shadowed the manifest endpoint → the whole console read the wrong payload) and **wired the Admin Console into the viewer nginx stack + compose mount** (the Settings "Staff sign-in / Admin" link 404'd before). |
| #12 | DIC-460 | **Choropleth by attribute** in the viewer + floating legend. `match` for categorical (`classGroup` transform → MI major class from `prop_class`), `step` for graduated. Dormant by default. |
| #13 | DIC-460 | **Editable choropleth** in the admin Styling module, then **generalized all styling to per-layer**. |
| #14 | DIC-496 | **Per-IP rate limiting on `/wms-proxy`** via `slowapi` (launch blocker). |

### Per-layer styling (the important architectural change, PR #13)
Styling is no longer parcels-coupled. Config is now **`styling.layers`** keyed by layer id:
```
styling.layers.<id> = { label, paint:{light,dark:{fill,stroke}}, choropleth:{ enabled, attribute, fields[], mode, transform, fallback, categories[], stops[] } }
```
- **Viewer** (`frontend/public/js/map.js`): `stylingLayers()` (with **back-compat** for the old `styling.parcels`/`styling.choropleth` shape), `mapLayersFor(id)` (parcels keeps bespoke ids; others use `${id}-fill`/`-line`), `applyLayerPaint()` per layer, legend = one section per choropleth-enabled layer.
- **Admin** (`admin/js/admin.js`): Styling module has a **layer picker**; paint + choropleth cards target the selected layer via `styling.layers.<id>.*` paths; attribute options come from the layer's `fields`. New `data-rerender` flag on the shared input handler; `ADD_TEMPLATES` lookup is now trailing-segment matched.
- Parcels is the only vector layer today, so the picker shows just "Parcels". New vector layers (DIC-461 ingestion) slot in **with no schema change**.
- Both config copies migrated: `frontend/public/js/county-config.js` (baked, viewer reads) **and** `backend/parcel_viewer/county_configs/vanburen.json` (served at `/config`). Keep them in sync.

### `/wms-proxy` rate limit (PR #14)
`slowapi` limiter scoped to `/wms-proxy` only, keyed on nginx `X-Real-IP` (fallback to socket peer). Default `45/minute`, env-tunable via `WMS_PROXY_RATE_LIMIT`. **Heads-up:** `45/min` is below the issue's own `~30–60 req/min per active user` estimate — flagged for Drake to confirm/raise (commented on DIC-496).

---

## What Drake did in parallel (2026-06-18)

- **DIC-320 deployment decision = Done.** The model: a **GCE VM** (DIC-317), *not* Cloud Run — one `e2-small` in `core-db-475718` hosting **both parcel-studio and parcel-viewer** as Docker-compose stacks, nginx by subdomain, shared Cloud SQL Auth Proxy + PgBouncer. Public, no-auth, assessment data public. Domain **`gis.dicemi.org`** first (DIC-497), later `gis.vanburencountymi.gov` (needs county IT). *(Our local Docker-compose model matches the VM target.)*
- **DIC-452 = Done — MapBuddy Cloud Run redeployed.** So the macro registry + **Automations palette** (DIC-430/431/432) and the **explainer `/explain` + `/explainers`** endpoints are now LIVE. That means the console's **Intelligence module** now has a live data source, and the viewer's Automations palette renders.
- **DIC-496 marked Done at 18:37** — but the actual `/wms-proxy` code on `main` is our PR #14 (merged clean, so nothing competing was on `main`). **Reconcile if Drake has a separate implementation** (noted on the issue).

---

## Launch path — DIC-499 "Parcel Viewer — public launch"

Remaining blockers (all **Drake / infra**, the legal long pole DIC-376 WCAG is already Done):
- **DIC-317** — provision the GCE VM ("nothing ships without it"). Do after DIC-310 (authorized-networks lockdown) + DIC-316 (PgBouncer).
- **DIC-497** — DNS `gis.dicemi.org` → VM static IP.
- **DIC-498** — rotate the Anthropic API key.
- **DIC-389** — SMTP creds for report-error email (now has a home: env on the VM `api`).

**When the VM + writable store (DIC-400/464) land, everything we built goes live in prod** — the Admin Console editing currently returns a dormant-safe `503` because no writer DSN is set (`config_store.py` + write endpoints exist; `docs/admin-console-provisioning.md` is the ~15-min runbook).

---

## Open follow-ups (ours / unowned)

- **DIC-500** (new, Bug) — `setupBufferLayers` in `map.js` adds `buffer-preview-parcels`/`buffer-seed-fill`/`buffer-seed-line` **without `source-layer`** → MapLibre rejects them, spams console every load, and **likely aborts the map `load` handler in headless/preview browsers** (this is why live map screenshots failed all session; reproduced with choropleth OFF, so not a styling regression). Good next pickup.
- **AV/TV choropleth** is blocked on the tiles: `geo.parcel_tiles` only exposes `prop_class, gis_acres, municipality, owner_name, parcel_no` (verified by decoding a live tile) — **not `av`/`tv`**. Needs the tile function to expose them (DB change). Noted on DIC-460.
- **DIC-460 styling epic** still open for: live sandboxed preview before publish; the AV/TV ramp (above).
- **`WMS_PROXY_RATE_LIMIT` default** (DIC-496) — confirm 45 vs ~90/min with Drake.

---

## Run locally (verified this session)

`.env` lives in repo root (gitignored; Cloud SQL at `34.170.241.253`, this machine's IP allowlisted). Slim stack:
```
docker compose -f infra/docker-compose.viewer.yml --env-file .env up -d --build --no-deps api martin web
```
- Viewer: **http://127.0.0.1:8080/demo/** · Admin Console: **http://127.0.0.1:8080/admin/** (also via Settings → "Staff sign-in / Admin").
- **Use `127.0.0.1`, not `localhost`** — `localhost`→`::1` hits a stale WSL instance; `127.0.0.1` forces our Docker container.

**Gotchas (these bit us):**
- **`api` is NOT bind-mounted** — rebuild it (`--build api`) after any Python edit *or* after changing `vanburen.json` (the manifest is baked into the image; `/config`/`/config.js` won't update otherwise).
- Frontend (`frontend/public/**`, `demo/**`, `admin/**`) **is** bind-mounted (live), but **nginx caches JS/CSS** — hard-refresh or `?v=` bust.
- **Browser verification:** the connected **Chrome MCP is on a *different machine*** (its `127.0.0.1:8080` is a stale stack — confirmed). The **Claude Preview MCP** works but its proxy needs port 8080, which Docker holds — free it by `docker stop infra-web-1`, then `preview_start parcel-viewer` (it runs `docker compose up`, bringing `web` back + proxying). Stop the preview + `up -d` to restore detached when done.
- **Branch discipline:** the Admin Console's nginx route + compose mount live in `infra/` — if you check out a branch off an older `main` and rebuild `web`, `/admin/` 404s → redirects to `/demo/`. (This bit us mid-session.) On `main` now, it's fine.

---

*Everything from 2026-06-18 is on `main` (`a13bc9f`). Durable state = this file + `main` + Linear (epics DIC-460 styling, DIC-462 access; launch tracker DIC-499; new bug DIC-500).*
