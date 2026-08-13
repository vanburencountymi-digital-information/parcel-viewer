# Parcel Viewer — deploy-readiness checklist

Target: a live URL for testing/development (~week of 2026-07-06), likely `parcels.dicemi.org`
(map-buddy's `ALLOWED_ORIGINS` already lists `parcels.dicemi.org` + `map.dicemi.org`).

Two deployables:
- **Viewer** — nginx + `api` (FastAPI) + `martin` (tiles). Defined in `infra/docker-compose.viewer.yml` / `infra/nginx.viewer.conf`.
- **Map Buddy** — the AI service, separate, on **Cloud Run** (`map-buddy/deploy.sh`).

Owner tags: **[repo]** = in-repo, done/doable here · **[infra]** = Drake / hosting · **[verify]** = check before/after.

---

## Critical path

1. **[infra] Deploy current Map Buddy to Cloud Run** — `bash map-buddy/deploy.sh`.
   - Ships the routes prod is **missing today**: `/describe-cohort`, `/judge`, `/autoconfigure`, `/status`, plus the C3 cache/quota and the KB resolver. Until this runs, the deployed viewer's AI features (cohort narrative, theme composer, grounding judge) won't work even though the UI is live.
   - Key comes from secret `MAP_BUDDY_ANTHROPIC_API_KEY` (already wired in deploy.sh). `ALLOWED_ORIGINS` already includes the prod viewer origins.
   - ⚠ **Cold starts:** deploy.sh sets `--min-instances 0`. The first AI call cold-starts (~seconds), which can briefly trip the "AI is unavailable" notice. We added health-check hysteresis so a single blip won't pop it, but for the testing window consider `--min-instances 1` (small cost, no cold-start hiccups).

2. **[verify] Viewer points at the deployed Map Buddy URL.** `deploy.sh` prints the Cloud Run URL; it must equal `COUNTY.endpoints.mapBuddy` in **all three** places:
   - `frontend/public/js/county-config.js`
   - `backend/parcel_viewer/county_configs/vanburen.json` (served as `/api/config.js` — the `api` image is baked, **rebuild it** if changed)
   - `engine/themes/vanburen.json`
   Today they read `https://map-buddy-toaozre74a-uc.a.run.app` — confirm that's the live service URL.

3. **[infra] Host the viewer stack** behind the live URL (nginx + api + martin).
   - **Caching:** there is **no content-hash build pipeline** (scripts load by literal paths). So either reuse the dev nginx's `no-store` on the viewer assets (`/demo/`, `/frontend/public/`, `/engine/`, `/map-buddy/` — all set in `infra/nginx.viewer.conf`), **or** front with a CDN that cache-busts. For a testing phase, **`no-store` is the safe default** (always fresh; we hit stale-JS repeatedly without it).

4. **[verify] Database reachability.** `api` + `martin` must reach the shared Cloud SQL PostGIS (`geo.*` + `assessing.vbc_parcels`) from the prod host. Restart `martin` after deploy so it discovers the `geo.*_tiles` functions.

5. **[decide] Tenant isolation (RLS).** If the deploy is single-tenant VBC (current), migration 015 can wait. If it serves more than one tenant, apply `county-data-services/migrations/015_tenant_isolation_rls.sql` and ensure the app sets `app.current_tenant` per request.

6. **[done] CI.** Harness workflow actions bumped to Node24-native majors (`4f7e043`); green on the pinned toolchain.

---

## Post-deploy smoke test [verify]
- Load the URL → a parcel selects, popup renders, labels follow pan.
- Open an explainer (Assessment / Tax Description) → AI narration arrives (proves Cloud Run + key).
- Open Neighborhood Profile → dashboard + environmental + AI "character" read (proves `/cohort` + `/describe-cohort`).
- Toggle dark mode (sun/moon swaps) and the theme works; console is clean.
- `GET <map-buddy-url>/status` → `ai_available: true`, cache/quota present.

## Known gotchas (already handled in-repo)
- `/map-buddy/` now sends `no-store` (was caching stale `map-buddy.js`).
- AI-availability uses hysteresis (no premature "unavailable" toast on a single cold-start blip).
- Theme icon swaps via attribute (SVG `.hidden` was a no-op).

## What deploy does NOT unblock
The keystone's last mile is **dev-environment**, not deployment: A3 contract-globals (needs parcel-studio runnable) and ZIP-as-a-theme (needs ZIP runnable + Lockport data migrated). A live URL helps testing, not these. See `engine/THEME_RENDERING_ACID_TEST.md`.
