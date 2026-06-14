# Parcel Viewer — Session Handoff

**Written:** 2026-06-14 (end of day) · **For:** new session on another machine, 2026-06-15
**Repo:** github.com/vanburencountymi-digital-information/parcel-viewer · **Branch:** `main` · **HEAD:** `80a429c`

> ⚠️ Claude's persistent memory lives in `~/.claude` and is **machine-local** — it will NOT be on the other computer. This file is the portable context. Read it first.

---

## TL;DR

There's a **short demo tomorrow (2026-06-15)**. Today was a GUI/design push: a **spatial-glass design system** + an **accessibility profile**. Everything is committed and pushed to `main` (clean tree). The app runs in Docker; frontend CSS/JS is bind-mounted (live on reload).

---

## How to run / preview

- **Run the app:** `docker compose -f infra/docker-compose.viewer.yml --env-file .env up` → serves on **:8080** (nginx + Martin tiles + FastAPI). Backend image changes need `docker compose -f infra/docker-compose.viewer.yml up --build -d api`.
- **Frontend** (`frontend/public/**`, `demo/**`) is bind-mounted → **live on page reload**, no rebuild.
- **Headless preview/testing proxy:** `py -3.14 tools/a11y-proxy.py` (proxies **:8091 → :8080**). Also see `.claude/launch.json` (`parcel-viewer`, `viewer-static`, `a11y-proxy`).
- 🐛 **nginx caches `.js`/`.css`** — a plain reload can serve **stale assets**. Cache-bust with a `?v=` query, or `fetch('/path.js?b='+Date.now())` to verify the served file actually has your edit before debugging.

---

## What shipped today

### Accessibility profile (the ADA core)
- **Header "Accessibility" button** = one-tap **"maximum accessibility"** toggle (turns on all settings) + a toast pointing to Settings; shows an active/pressed state.
- **Granular controls live in Settings:** text size (Default/Large/Larger), high contrast, reduce transparency, legible font (**Atkinson Hyperlegible**, loaded from Google Fonts), reduce motion, language stub.
- Prefs applied as `<html>` classes (`pv-a11y-*`), **persisted** in localStorage, **OS-seeded** on first run (`prefers-reduced-motion` / `-contrast` / `-reduced-transparency`).
- `A11Y` module + `openAccessibility` logic in `admin-menu.js`; the old separate Accessibility modal was folded into Settings.

### Spatial-glass design system
- Token sheet in `style.css` (`--glass-*`). All surfaces (parcel popup, control panel, search dropdown, admin menu, modal) share one elevation language (shadow / rim / radius).
- **Panel transparency is user-adjustable:** `--glass-alpha` token (default **0.62**) composed into `--glass-frame`. A **"Panel glass" slider in Settings** sets it live (40–100%) and persists (`pv-glass-alpha`, applied by `applyGlassPref()` on load).
- **Glass-object styling** (`--glass-object-shadow`): deep float + outer hairline + top sheen + inner glow, so panels feel like frosted-glass slabs on any backdrop.
- Translucent headers (`--glass-header`, ~0.86 — more opaque than the body), transparent tool rail, glass search dropdown, semi-transparent gold scrollbar thumbs.

### Bugs fixed today
- **Dark-mode high contrast** was inverted (text went darker). Cause: `[data-theme="dark"] html.pv-a11y-*` can never match (html can't be its own descendant). Fixed → `html[data-theme="dark"].pv-a11y-*`.
- **MapBuddy ignored a11y** — it's `#map-buddy-panel`, not the guessed `#panel-chat`. Added to the rules.
- **Map-controls reopen tab vanished in a11y mode** — it was `position:fixed` over MapBuddy; fixed → `position:absolute` in `#panel-map` + `right:0 !important`.
- **TV row looked solid** in the parcel popup — it was zebra striping (`tr:nth-child(even)`); removed.

---

## Key files

| File | What |
|------|------|
| `frontend/public/css/style.css` | Brand + glass + a11y tokens, panels, scrollbars, the whole design system |
| `frontend/public/css/viewer.css` | Modal (`.pv-modal`), header buttons, Parcel Packet styles (`.pp-*`) |
| `frontend/public/js/admin-menu.js` | `openModal`, `openPacket()` (Packet mock), `A11Y` module, `openSettings` (incl. glass slider), toast |
| `frontend/public/js/map.js` | `showParcelInfo` (parcel popup), `PV_PREFS` (localStorage prefs store) |
| `demo/index.html` | Topbar markup, Accessibility button, Atkinson font link |
| `frontend/public/design/spatial-glass-concept.html` | Throwaway design-reference mock (not wired into app) |

---

## Gotchas & constraints (important)

- **nginx asset caching** — see Preview section.
- **Deployed `/map-buddy/js/map-buddy.js` is a BUNDLED artifact, not the repo source.** Editing the source `map-buddy/js/map-buddy.js` does NOT change runtime behavior. Fix MapBuddy issues via CSS overrides, or rebuild the bundle.
- **Read-only DB role** — blocks live tax/assessment data and any writes. `report-error` uses SMTP email as a workaround. Needs Drake: SMTP creds (DIC-389), DB persistence (DIC-391), and the writable-store/keys foundation (DIC-400) which gates several future features.
- **Glass "wow" is a contrast effect, not a tint level** — it's subtle over the flat light Positron / dark basemaps (light-on-light / dark-on-dark) and pops over **aerial imagery** or zoomed-in parcel areas. This is physics, not a tuning miss. The slider + accessibility "reduce transparency" are the levers.

---

## Suggested demo flow (2026-06-15)

1. Open the viewer → the glass panels.
2. Search a parcel (e.g. an owner name) → the **glass popup** with real assessment data + the AV-history chart. MapBuddy picks up the parcel context.
3. Hit the **Accessibility** button → one-tap profile (bigger text, solid panels, legible font); toggle **dark mode** to show contrast holds.
4. Open **Settings** → granular accessibility controls + the **Panel glass** slider (drag it live to show the range).
5. Click **Generate Parcel Packet** on the popup → the rich mock (Parcel Ledger timeline, sections with "What this means" + section-scoped chat, Tax Description explainer, Share/Embed panel).
6. Tip: toggle **Aerial Imagery** or zoom into a parcel cluster to show the glass at its best.

---

## Linear state (system of record)

- **Parcel Viewer** project: ~51 issues. **Parcel Packet** project: 46, all Backlog (everything there is spec/mock; nothing built yet — correct).
- **In Progress (only real open work):**
  - **DIC-376** — pre-launch WCAG audit. Automated work done; the **human keyboard/screen-reader cert pass** is what remains before sign-off (launch blocker for public deploy).
  - **DIC-421** — spatial-glass design language. Demo-ready; follow-ups: wire the **per-theme AA / profile-AAA invariant into the axe harness**, and future theme palettes (911/valuation) when those themes are built.
- **Closed today:** DIC-368 (placeholder-tools wiring) → Done.
- **Packet roadmap:** DIC-330 (concept) · **DIC-414** comprehensive parcel endpoint (+ children 415–419) · DIC-413 section-scoped chat · DIC-420 sharing/embedding paid add-on · DIC-422 i18n. All Backlog (demo mocks exist behind the Packet button).
- **Design direction:** Linear doc *"GUI / Creative Direction — options to consider"* (Parcel Viewer project). **Hero map (3D/cartography) is deferred pending data layers.**

---

## Open threads / what's next

- **Demo tomorrow.** If a preferred default `--glass-alpha` emerges, bake it in as the shipped default (currently 0.62).
- DIC-421 follow-ups: axe AA/AAA harness check; per-theme palettes.
- DIC-376: schedule the human a11y certification pass before public launch.
- Drake items: SMTP creds (DIC-389), rate-limiting (DIC-390), writable store + keys (DIC-400).
- The Packet is all mocks — the real build starts at **DIC-414** (endpoint) with **DIC-416 (ledger)** as the spine to build first.

---

*Today's commits (newest first): `80a429c` concept mock · `fb55483` glass polish + TV fix · `cc37976` glass-object + slider · `fd87c0f` translucent panels · `598e95f` substrate (reverted) · `2c9f3ff` stronger glass + tab fix · `30661bc` tint unify · `5ddf81e`/`7724ef1` glass sweep · `73d7c5f` one-tap a11y + fixes · `cdb3bf1` glass tokens · `6ef2b18` accessibility profile.*
