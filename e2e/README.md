# Parcel Viewer — browser end-to-end tests

Playwright tests that drive the real viewer in a real browser: search, the parcel panel,
map clicks, every Map Buddy command, every tool window, the Select / Measure / Draw tools,
layer toggles, error states, theme and accessibility controls, and a phone viewport.

## Run

Needs the local stack up (`docker compose -f infra/docker-compose.viewer.yml --env-file .env up -d`)
with a reachable database. Uses the installed **Microsoft Edge** (no browser download).

```bash
cd e2e
npm install
npx playwright test                 # everything (desktop + mobile projects)
npx playwright test tests/map-buddy-commands.spec.js   # one file
npx playwright show-report          # HTML report with traces/screenshots of failures
```

| Variable | Default | Purpose |
|---|---|---|
| `E2E_BASE_URL` | `http://127.0.0.1:8080` | Stack under test (e.g. a staging URL) |
| `E2E_CHANNEL` | `msedge` | `chrome` to use Google Chrome instead |
| `E2E_AI` | unset | `1` runs the AI chat tests, which call the real model (costs a little) |

## What every test checks, beyond its own assertions

A **console guard** (`tests/fixtures.js`) fails any test that logs a console error or throws
an uncaught exception, unless that test declares the specific error expected. Silent
breakage — a handler throwing, a failed fetch nobody surfaces — is what these tests hunt.
The only global exception: up to two failed `/ws` connection attempts, because the
standalone viewer has no live-update backend (Parcel Studio does); `smoke.spec.js` asserts
that bound so a reconnect loop can't come back unnoticed.

## Files

| Spec | Covers |
|---|---|
| `smoke` | Clean load (10s of console silence), Esri basemap, pinned libraries under SRI, config + Map Buddy endpoint, no `/ws` reconnect spam |
| `search-and-panel` | Search via UI, keyboard nav, no-match message, no stale results, panel close clears selection, Esc in a dialog keeps the selection |
| `map-click` | A real mouse click on the canvas selects the parcel |
| `map-buddy-commands` | Every command that opens a window/tool/mode: it closes, releases the map-click gate, and a real click still selects a parcel (regression guard for DIC-1875) |
| `tool-windows` | Every Help & tools menu window and parcel tool: open, close by button, close by Esc, focus not lost |
| `map-controls` | Every Select / Measure / Draw tool arms and exits, releasing the gate and restoring panning |
| `layers` | Every layer toggle on/off; aerial replaces the street basemap |
| `error-states` | Style/config/search/parcel/Map Buddy failures (simulated with request interception) show the right message or fallback |
| `theme-a11y` | Dark mode persists, accessibility + AI toggles, text-size clamp, blocked browser storage |
| `mobile` | Phone viewport: tab bar, search overlay, selection, no horizontal overflow |

## Proving a test catches its bug

A test that has only ever passed proves little. For regressions, check it against the old
code: e.g. swapping `main`'s pre-fix drawing files into the running stack makes
`map-buddy-commands` fail with exactly the reported symptoms (popup stays open; draw tool
holds the gate), and it passes again with the fix.

## Not covered (yet)

- **Print** — opens the browser's print dialog, which blocks automation. Check by hand.
- **Street View** — opens Google Maps in a new tab (no embed key configured).
- **CI** — the suite needs the database, so it runs locally today; CI needs a fixture DB.
