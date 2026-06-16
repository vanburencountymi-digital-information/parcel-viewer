# Parcel Viewer — Session Handoff

**Written:** 2026-06-16 (end of day) · **For:** next session on another machine, 2026-06-17
**Repo:** github.com/vanburencountymi-digital-information/parcel-viewer · **Branch:** `main` · **HEAD:** `387c751`

> Claude's persistent memory lives in `~/.claude` and is **machine-local** — it will NOT be on the other computer. This file is the portable context. Read it first. `git pull` before starting.

---

## TL;DR

Big day: **9 features merged to `main`** (orbit toggle, search ranking, infra fix, color schemes, the MapBuddy macro epic A/B/C, progressive disclosure, and the templating/export foundation). Tree is clean; everything is pushed and merged.

**The one thing blocking the new stuff from being visible:** the **MapBuddy Cloud Run service has not been redeployed**, so the macro work + Automations palette aren't live (see DIC-452). On localhost, MapBuddy points at Cloud Run, which is currently behind `main`.

---

## Shipped today (all merged, PRs #1–#9)

| Issue | What |
|------|------|
| DIC-435 | Settings toggle to disable the search fly-around orbit |
| DIC-436 | Address search ranked by relevance (fixes `219`→`34219` ordering) |
| DIC-437 | nginx boots without map-buddy (lazy resolver); MapBuddy → Cloud Run on localhost |
| DIC-434 | Color-scheme presets — 6 AA-verified palettes, **full GUI recolor** (incl. headers/buttons) via `--ui-*` / `--ui-header-*` / `--ui-on-interactive` triplet tokens + `data-scheme` on `<html>` |
| DIC-430 | Declarative MapBuddy macro registry (`WORKFLOWS` in `map-buddy/backend/agent.py`) |
| DIC-431 | Parameterized + branching macros (`$param` interpolation, `when` conditions on env) |
| DIC-432 | Visible **Automations palette** in MapBuddy: `GET /workflows` + `POST /workflow` (deterministic, key-free) in `main.py`; collapsible palette in `map-buddy.js` |
| DIC-402 | Progressive disclosure — basic default (Layers only) + **Advanced Tools** toggle revealing Select/Draw/Measure; config-overridable via `COUNTY.tools.advanced` |
| DIC-372 | **Shared templating + export foundation** — `pv-template.js` (`PV_TEMPLATE`, Mustache-subset engine, 15 unit tests) + `pv-doc.js` (`PV_DOC`: map-image capture, parcel-summary doc, print/PDF + HTML download). Print tool upgraded from placeholder. |

New reusable modules for future features: **`PV_TEMPLATE`** (templating) and **`PV_DOC`** (export) — the Parcel Packet and the Tax/Assessment explainers should build on these.

---

## ⚠️ Critical: redeploy MapBuddy Cloud Run (DIC-452)

DIC-430/431/432 are MapBuddy **backend** changes. They're in `main` but **not live** until the standalone MapBuddy Cloud Run service is redeployed (`map-buddy/deploy.sh`). Until then:
- The **Automations palette doesn't render** (Cloud Run `/workflows` 404s — confirmed).
- Macro params/branching aren't available in chat.
- **Caveat:** the deployed `map-buddy/js/map-buddy.js` may be a **bundled artifact** — the palette frontend may need the bundle rebuilt at deploy, not just the source merged.

Owner: likely Drake (infra). This is the highest-value next action to make today's macro work visible.

---

## How to run locally (on the new machine)

1. **Recreate `.env`** in the repo root (gitignored — it does NOT travel with the repo). You have the two DSNs (Cloud SQL at `34.170.241.253`):
   ```
   PV_DATABASE_URL=postgresql://parcel_studio_app:...@34.170.241.253:5432/postgres?sslmode=require
   MARTIN_DATABASE_URL=postgresql://martin_ro:...@34.170.241.253:5432/postgres?sslmode=require
   PV_MARTIN_PUBLIC_URL=/tiles
   PV_HTTP_PORT=8080
   ```
2. **Allowlist the new machine's public IP** on the Cloud SQL instance (Drake / DIC-311) — otherwise `api`/`martin` can't reach the DB.
3. Bring up the **slim stack** (skips the local map-buddy container — MapBuddy uses Cloud Run):
   ```
   docker compose -f infra/docker-compose.viewer.yml --env-file .env up -d --build --no-deps api martin web
   ```
4. Open **http://localhost:8080** → `/demo/`.

**Gotchas (these bit us today):**
- On the *previous* dev machine, a leftover WSL instance squatted `::1:8080`, so we used **`127.0.0.1:8080`** to avoid stale code. On a fresh machine `localhost` should be fine — but if you see stale assets, try `127.0.0.1` and check for a second server on the port.
- **nginx caches JS/CSS** — hard-refresh (Ctrl+Shift+R) or `?v=` after edits. Frontend (`frontend/public/**`, `demo/**`, `map-buddy/**`) is bind-mounted (live on reload); the **`api` and `map-buddy` backends are NOT auto-reloaded reliably on Docker Desktop** — restart the container after Python edits.
- **MapBuddy on localhost → Cloud Run** (by design). The local map-buddy container has **no `ANTHROPIC_API_KEY`** (none in `.env`), so it can't do chat — only the deterministic `/workflows` + `/workflow` endpoints. To test the Automations palette locally before the redeploy, point `COUNTY.endpoints.mapBuddy` at `/map-buddy-api` (local container has the latest code); chat still needs a key.

---

## Open threads / what's next

- **DIC-452** — redeploy MapBuddy Cloud Run (unblocks macros + palette). *Highest leverage.*
- **DIC-320** — public deployment & access decision — **assigned to Drake**; it gates the rest of the infra launch track (DIC-316 PgBouncer, DIC-317 VM, DIC-389 SMTP, DIC-390 rate-limit).
- **DIC-454** — templating persistence (PIN+version) + stable custom URLs — gated on the writable store (DIC-400, Drake).
- **DIC-433** — user-saved macros (macro epic D) — gated on the writable store.
- **DIC-438** — county WMS aerial — **canceled** (Drake serving imagery from cloud storage instead). Branch `geraldhappel/dic-438-county-wms-aerial` pushed for reference; CORS on the QGIS WMS was confirmed working.
- Feature backlog (Jerry's lane, not deploy-gated): Tax/Assessment explainers (DIC-369/370) — now buildable on `PV_TEMPLATE`/`PV_DOC`; i18n (DIC-422); mobile polish (DIC-321).

**Launch status:** the WCAG 2.1 AA audit (DIC-376) + all child a11y findings are **Done** — the legal long pole is cleared. Remaining launch blockers are infra (Drake), gated by the DIC-320 decision.

---

*Today's merges (newest first): #9 DIC-372 templating · #8 DIC-402 progressive disclosure · #7 DIC-432 Automations palette · #6 DIC-431 macro params/branching · #5 DIC-430 macro registry · #4 DIC-434 color schemes · #3 DIC-437 infra · #2 DIC-436 search · #1 DIC-435 orbit toggle.*
