# Parcel Viewer — Session Handoff (2026-06-13)

Rolling session-to-session handoff (distinct from `docs/HANDOFF.md`, which is the
deployment runbook). Last session focused on the **mobile UI**.

## What shipped this session

All committed at **`5b9245d`** and pushed to `main`. Rebased cleanly on top of
**`e6fbaf7` "rewire mapbuddy as a microservice"** (a parallel session's work) — no
conflicts. MapBuddy now mounts against a Cloud Run URL
(`window.MAP_BUDDY_API || 'https://map-buddy-toaozre74a-uc.a.run.app'`).

Mobile UI rework (desktop unaffected — everything is scoped under
`@media (max-width: 640px)` or desktop-specific selectors):

- **Unified mobile tab bar** under the topbar: `Parcel Info | Map Controls | MapBuddy A.I.`
  All panels start **closed** on load.
- **Parcel Info & Map Controls** = mutually-exclusive **top drop-downs** from the tab
  bar (anchored `top:82px` = 50px topbar + 32px tab bar). Opening one closes the other;
  selecting a parcel auto-opens Parcel Info and closes Map Controls. Parcel Info tab is
  `disabled` until a parcel is selected.
- **MapBuddy A.I.** = **bottom-half split-screen drawer** (50vh). Opening it sets
  `body.mb-mobile-open`, which pushes `#panel-map` into the top half and calls a map
  resize so the map + a parcel dropdown stay visible while chatting. **No header** on
  mobile (the `.mb-drawer-handle` is the title + tap-to-collapse); added an explicit
  **✕ close** button; collapsed = `display:none`.
- **Search** = full-screen overlay (mobile). Results now **persist after a selection**
  (desktop parity — pick the wrong parcel, reopen, remaining matches still there). The
  overlay needs an explicit `height:calc(100dvh-50px)` or it collapses.
- Removed the red **selection-count badge** (mobile + desktop).
- Dark-mode **page background** (`[data-theme="dark"] body,#app { #120d0b }`) so panel
  corners don't flash white.
- Renamed **"Map Buddy" → "MapBuddy A.I."** across all user-facing labels + the startup
  screen (code API `MapBuddy.mount()` / `#map-buddy-panel` IDs unchanged).

## ⚠️ Verification status

Verified the layout/behavior in a connected Chrome at mobile width (tab bar, dropdowns,
split-screen positions, search persistence, close button, rename). **Could NOT verify**
two things in the dev sandbox because the map's `load` event never fires there (tiles/
style unreachable → `window.PS_MAP` stays undefined):

1. The live **map canvas resize** when MapBuddy opens (container shrinks to 50vh, but
   `map.resize()` couldn't be exercised). `_pushMap()` in `map-buddy.js` calls
   `PS_MAP.resize()` with a window-resize fallback + retries (0/80/260ms) — correct for
   prod, but **confirm on a real device/desktop** that the canvas refits cleanly.
2. The **parcel-selection** flow on mobile (auto-open Parcel Info, close Map Controls).

## How to run / rebuild

- **Frontend** (`demo/`, `frontend/public/`, `map-buddy/css|js`): bind-mounted —
  edit + hard-refresh (Ctrl+Shift+R). No rebuild.
- **Read API** (`backend/parcel_viewer`): `docker compose -f infra/docker-compose.viewer.yml --env-file .env up --build -d api`
- **MapBuddy** is now a **separate microservice** (`map-buddy/backend/`, deployed to
  Cloud Run via `map-buddy/deploy.sh`) — see commit `e6fbaf7`.
- Local dev note: port 8080 is held by Docker (`infra-web-1`), so the Claude preview
  server can't bind; test against the running `localhost:8080` instead.

## Mobile architecture map (for the next editor)

- `demo/index.html` — `#pv-mobile-tabbar` (3 tabs), `#pv-search-btn`/overlay markup
- `frontend/public/css/viewer.css` — tab bar styles, search overlay, dark `body` bg
- `frontend/public/css/style.css` — mobile `@media` block: top-dropdown panels,
  `body.mb-mobile-open #panel-map` push, dropdown caps
- `frontend/public/js/map.js` — `initMobileTabs()` (exposes `window.PV_MOBILE_TABS.refresh()`),
  search linger logic (`closeMobileSearch` vs `resetMobileSearch`)
- `map-buddy/js/map-buddy.js` — `_pushMap()`, `_init` mobile-collapse default, ✕ wiring,
  `PV_MAP_BUDDY.toggle/isOpen`
- `map-buddy/css/map-buddy.css` — mobile bottom-drawer + `.mb-mobile-close`

## Linear

- **DIC-321** (Mobile-friendly UI — ongoing) — description + comment updated this session.
  Remaining gaps: **swipe-to-dismiss**, **touch tooltip fallback** (`data-tip` is
  hover-only), **real-device field testing** (incl. the two unverified items above).
- Other open backlog: **DIC-318** (acreage SQL backfill), **DIC-319** (school districts
  → DB table), **DIC-320** (public deployment planning).

## Good next starting points

- **Real-device pass** on the mobile rework (confirm map resize + parcel selection).
- **DIC-320** public deployment — now more relevant since MapBuddy is a Cloud Run
  microservice; the viewer's own hosting/domain/auth is the open question.
- **DIC-318** acreage SQL — self-contained warm-up.
