# Parcel Viewer — Session Handoff (2026-06-13, GUI tooling)

Rolling session-to-session handoff (distinct from `docs/HANDOFF.md`, the deployment
runbook). This session was a **GUI pass**: a Tools menu, in-popup info windows,
release notes, a county-config extraction, and coordinate features. It follows the
earlier same-day mobile-UI rework session (commit `5b9245d` / handoff `8c84887`).

Data and real functionality wiring come later — most of what shipped here is UI +
placeholders, deliberately.

## What shipped this session

All committed and pushed to `main` (oldest → newest):

- `3b63748` **Overlay error handling** — `wms-feature-info.js` now fails fast (8s
  AbortController timeout per query) and, when all overlay servers error, logs to
  console instead of drawing a wall of "HTTP 505" in the popup. Fixes the slow/ugly
  overlay-query window when an upstream is down.
- `4fc79ce` **Admin Tools menu** — topbar hamburger dropdown + a Layers "Parcel
  Tools" section. New `frontend/public/js/admin-menu.js` (reusable modal + form
  helpers + `.pv-ptool`/`.pv-info-btn` event delegation).
- `d3dd17b` **Relocated tools** — Generate Parcel Packet + Compare Parcels moved to
  the **parcel popup**; Street View stays in **Map Controls** ("Map Tools" section).
- `807302c` **Tax Description info window + What's New** — ⓘ on the Tax Description
  header (disclaimer + explainer teaser); "What's New" dropdown item with curated,
  dated release notes.
- `ac981d5` **Assessed Values info window** — ⓘ on the Assessed Values header
  ("About Property Assessment"); removed the hover-only `*` caveat; generalized the
  icon to `.pv-info-btn[data-info]`.
- `ba094ab` **County config manifest** — `frontend/public/js/county-config.js`
  (`window.COUNTY`). Single source of truth for county-specific values; onboarding a
  county is now "edit one file." (See DIC-371.)
- `7cee7f3` **Live coordinate readout** — bottom-right pill tracking the cursor;
  click cycles DD / DMS / Michigan State Plane (persisted). Exposes
  `window.PV_COORDS.setFormat()`.
- `ee262d3` **Parcel center coordinates** — "Center" row in the popup via
  `turf.pointOnFeature` (interior-guaranteed point, not the bbox center), formatted
  to the active readout format.

## Key seams / where things live

- **`county-config.js`** (`window.COUNTY`) — name, state, `map.{extent,center,zoom}`,
  `labels.{propClass,schoolDist}`, `forms.dataRequest`, `endpoints.mapBuddy`. Load
  it first; consumers read with fallbacks.
- **`admin-menu.js`** — `openModal(title, html, onMount, {wide, flush})` shared modal;
  the dropdown tools, the parcel/map tools (`.pv-ptool[data-ptool]`), and the section
  info buttons (`.pv-info-btn[data-info]`) all route through here. Forms log to
  console only (no backend yet) and placeholders show a "Preview" badge.
- **`map.js`** — `representativePoint()` (turf), `_formatLngLat()` + the coordinate
  readout (`window.PV_COORDS`), county-config consumption, `showParcelInfo(pin,p,geom)`.

## ⚠️ Verification status

The Claude preview sandbox **cannot load the live map** — maplibre (and turf) come
from CDNs that are blocked there, so `map` never constructs. Map-independent UI was
verified by driving a static server (`python -m http.server`, port 8090 — see the
`viewer-static` entry in `.claude/launch.json`): dropdown, all modals, forms, dark
mode, mobile widths, county-config wiring, and the coordinate-format math.

**Not yet eyeballed on a real map — confirm on `localhost:8080` (hard-refresh):**
- In-popup buttons (Packet/Compare) + the two ⓘ info icons render with a parcel
  selected; tax header no longer shows `*`.
- The **"Center"** coordinate row, and that it reformats when you cycle the readout
  and reselect.
- The **live cursor readout** updates and click-cycles DD/DMS/State Plane.
- Overlay query still shows data popups; a down server now stays silent (console only).

## Linear

Created this session (all in the Parcel Viewer project):
- **DIC-368** — Tools menu & parcel-tools tracking + wireup checklist (Print→DIC-42,
  Share→DIC-52, Packet→DIC-340/330, Compare→DIC-54/366, Street View→DIC-55; new:
  Bookmark, Report-a-data-error, Settings).
- **DIC-369** — Tax Description Explainer (AI; Phase-0 stub shipped).
- **DIC-370** — Assessment Explainer (AI + tax DB; Phase-0 stub shipped).
- **DIC-371** — County config manifest (**initial extraction done**; DB/registry/
  server-inject follow-ups remain).
- **DIC-372** — Shared HTML templating + persistence/share/export layer.
- **DIC-373** — Modal accessibility pass (focus trap/restore).
- **DIC-374** — Canonical parcel representative point (`ST_PointOnSurface`) in the DB.

## Good next starting points

- **Confirm the GUI on `localhost:8080`** (the four items above) — quickest close-out.
- **DIC-373 modal a11y** — small, self-contained (focus trap + restore on the one
  shared modal).
- **Wire forms to a backend** (Report a data error, future Feedback) — currently
  console-only; pick an endpoint or mail/Formspree shim.
- **DIC-369 Phase 1** — text-only AI explainer (terminology + tax-vs-legal), the
  low-risk entry into the explainer work.
- **DIC-371 follow-ups** — move label maps to the DB; data-driven overlay registry.

## How to run / verify

- **Frontend** is bind-mounted into the running `infra-web-1` nginx — edit + hard-
  refresh `localhost:8080` (Ctrl+Shift+R). No rebuild.
- Docker holds port 8080, so the Claude preview server can't bind it; for
  map-independent UI checks use the `viewer-static` launch config (serves the repo on
  :8090). Live-map checks must be on `localhost:8080`.
