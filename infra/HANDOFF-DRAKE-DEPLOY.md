# Deploy handoff — Parcel Viewer → live URL (for Drake)

Written 2026-06-28. Repo state: `main` @ `e00261d`, pushed & in sync. Harness 286 green, CI green.
Quick step list: `infra/DEPLOY-CHECKLIST.md`. This doc is the "where things stand + what you do" narrative.

---

## Where things stand (read first)

Parcel Viewer is feature-complete for a testing/dev launch. Since the last prod deploy a large amount
landed on `main` that is **NOT in prod yet** — so **prod is stale across the board**, not just in one
service. This deploy brings prod up to current `main`. What's new since last deploy includes: the whole
cohort-analysis suite (Compare + Neighborhood Profile + 4 area selectors + environmental + AI narrative),
the theme system (theme-file boot, registry, chooser), manifest-driven config (AC7), the new Map Buddy
AI routes, the C1–C5 hardening, and a batch of UI fixes.

**Nothing here needs new infra you don't already run** — it's a redeploy of the same shapes (viewer
stack + map-buddy on Cloud Run) from current code, plus a couple of decisions (below).

---

## What you're deploying — 3 services, all from current `main`

| Service | Where | Source | Why it must update |
|---|---|---|---|
| `map-buddy` | Cloud Run (`core-db-475718`, `us-central1`) | `map-buddy/backend/` | Prod is **missing** the new AI routes: `/describe-cohort`, `/judge`, `/autoconfigure`, `/status`, + result cache/quota + KB resolver. AI features fail until this ships. |
| `api` | your viewer host | `backend/` (Dockerfile) — baked image | Serves the new `/cohort`, `/cohort/geographies` routes + the served `/api/config.js`. **Rebuild it** (it's a baked image). |
| `web` (nginx) | your viewer host | `infra/nginx.viewer.conf` + static `demo/`, `frontend/public/`, `engine/` | Serves the entire current frontend (cohort UI, theme chooser, label/icon fixes). |
| `martin` | your viewer host | unchanged image | No code change — just **restart** after deploy so it re-discovers any `geo.*_tiles` functions. |

---

## Do this (order matters)

1. **Deploy Map Buddy → Cloud Run:** `bash map-buddy/deploy.sh`
   - Already wired: image build/push to Artifact Registry, key from secret `PS_ANTHROPIC_API_KEY`,
     `ALLOWED_ORIGINS` = `https://map.dicemi.org, https://parcels.dicemi.org, localhost…`.
   - ⚠ It sets `--min-instances 0`. First AI call cold-starts (~seconds); for the testing window I'd
     bump to `--min-instances 1` so the explainers/cohort AI don't briefly show "AI unavailable" on a
     cold ping. (We added health-check hysteresis so a single blip won't trip it, but warm is nicer.)
   - The script prints the service URL at the end — **note it for step 3.**

2. **Deploy the viewer stack** (`api` + `web` + `martin`) from current `main` via your hosting.
   - The repo only ships the **dev** compose (`infra/docker-compose.viewer.yml`); the prod hosting
     mechanism is yours. Whatever it is, it must **rebuild `api` from `backend/`** and serve the
     current static frontend through nginx.
   - **Caching:** there is **no content-hash build pipeline** (scripts load by literal paths). The dev
     nginx already sets `Cache-Control: no-store` on the viewer assets (`/demo/`, `/frontend/public/`,
     `/engine/`, `/map-buddy/`). For a testing phase, keep `no-store` (always fresh — we hit stale-JS
     repeatedly without it) **or** front with a CDN that cache-busts. Don't serve these assets with a
     long max-age and no hashing.
   - Restart `martin` after the stack is up.

3. **Make the viewer point at the deployed Map Buddy.** The Cloud Run URL from step 1 must equal
   `COUNTY.endpoints.mapBuddy` in **all three** copies — today they read
   `https://map-buddy-toaozre74a-uc.a.run.app`:
   - `frontend/public/js/county-config.js`
   - `backend/parcel_viewer/county_configs/vanburen.json`  ← served as `/api/config.js` (rebuild `api` if changed)
   - `engine/themes/vanburen.json`
   If the deployed URL matches today's value, nothing to change. If it differs, update all three and
   rebuild `api`.

---

## Decisions you need to make

- **Live hostname.** `ALLOWED_ORIGINS` already lists `parcels.dicemi.org` + `map.dicemi.org`. Confirm
  the actual hostname; if it's different, add it to `ALLOWED_ORIGINS` in `deploy.sh` and redeploy map-buddy.
- **Single- vs multi-tenant.** If this serves **only VBC** (expected), tenant RLS isn't required — skip it.
  If it will serve more than one jurisdiction, apply `county-data-services/migrations/015_tenant_isolation_rls.sql`
  and ensure the app `SET app.current_tenant` per request (it's fail-closed: unset = no rows).
- **Real KB citations (optional).** Map Buddy's citation resolver defaults to a local JSON fixture (works
  with no extra setup). To resolve citations against the real `knowledge.chunks`, set `KB_BACKEND=dice`
  on the Cloud Run service and make sure it can reach the KB DB. Fine to leave on the fixture for testing.

---

## Database

Shared Cloud SQL PostGIS (`geo.*` overlays + `assessing.vbc_parcels` + `knowledge.chunks`). `api` and
`martin` must reach it from the prod host (`parcel_studio_app` for the app, `martin_ro` for tiles). The
Avast/Web-Shield-during-migrations note is **local-machine only** — not a prod concern.

---

## Post-deploy smoke test

- Load the URL → a parcel selects, popup renders (Parcel / Owner / Assessed Values + AV chart), labels follow pan.
- Open an explainer (Assessment) → AI narration arrives → proves Cloud Run + key + the viewer→map-buddy URL.
- Open Neighborhood Profile → dashboard + environmental + AI "character" read → proves `/cohort` (api) + `/describe-cohort` (map-buddy).
- Toggle dark mode (sun/moon swaps), check the console is clean.
- `GET <map-buddy-url>/status` → `{ ai_available: true, cache: …, quota: … }`.

---

## Already handled in-repo (so you don't chase these)

`/map-buddy/` no-store · AI-availability hysteresis (no premature "unavailable" toast) · theme icon swap
· parcel-label AV/TV/TMV · CI harness actions bumped to Node24-native majors.

## What this deploy is NOT (set expectations)

It does **not** advance the "ISV engine renders any theme" finish line — that's blocked on dev-environment
work (parcel-studio + ZIP runnable, Lockport data migrated), not deployment. The live URL helps testing,
not that. See `engine/THEME_RENDERING_ACID_TEST.md`. And it does **not** touch the parcel-studio contract
globals (`PS_MAP`/`PS_STATE`/drawing) — those stay as-is.

## Open questions for you / Jerry
- Final live hostname(s)?
- Single-tenant VBC for now (→ skip RLS), or multi-tenant?
- Keep map-buddy at `--min-instances 0` (cheaper, cold starts) or `1` (warm) for the testing window?
- Fixture KB or real `knowledge.chunks` (`KB_BACKEND=dice`) for citations?
