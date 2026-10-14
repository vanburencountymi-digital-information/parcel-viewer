# 17. The front end moves to Vue, one panel at a time

## Status

Accepted (Jerry, 2026-10-14; DIC-2389)

## Context

The viewer's UI is about 45 classic scripts (around 16,000 lines; `map.js` alone is 3,900). They share state through `window.*` globals and update the page by hand: build an HTML string, escape each value, set `innerHTML`, then wire the listeners again. That works, but it makes changes risky and new people slow, and every hand-built string is an escaping bug waiting to happen.

The team's "Suggested Architecture Boilerplate" (Maria) recommends Vue when a front end needs more than Django templates, because it can be adopted gradually, and it argues that projects sharing frameworks lower the team's knowledge burden. The API is already Django (ADR 0004, DIC-2150). The DIC-2180 prep made the move practical: Vite builds the pages, the engine and several viewer files are ES modules, and the e2e suite finds elements by role, label and test id rather than page structure.

A rewrite would mean weeks with nothing to ship and nothing to check it against.

## Decision

- **Vue 3, a panel at a time ("islands").** Each panel becomes a Vue component mounted into today's page, and everything else keeps working unchanged. Slices are in DIC-2389; the first is the Compare tray and table.
- **One module entry, `frontend/src/main.js`**, loaded as `<script type="module">` at the end of `demo/index.html`. A module runs once the page is parsed, so after every classic script: the window hooks the islands read exist by then. Each island mounts in its own `try`, so one that throws doesn't stop the others, and its error reaches `pv-error-beacon.js`. Vite builds the entry itself; the classic-scripts plugin leaves module tags alone.
- **Single-file components with `<script setup>`, in plain JavaScript**, like the rest of the front end. Templates are compiled at build time, so the page needs no runtime compiler and no `unsafe-eval` in the CSP.
- **Islands reach the rest of the viewer only through `frontend/src/shared/viewer.js`**, read at call time. Each island keeps the `window` API its callers use (e.g. `PV_COMPARE`), so the classic scripts, Map Buddy and the tests need no change.
- **Logic lives in plain modules (a store, a table model) with the viewer injected,** and Vitest tests them and the components (`npm test`, happy-dom). The e2e suite stays the parity check: a slice merges when the full suite is green.
- **Markup parity:** a component keeps the ids, classes, test ids and accessible names it replaces, so the CSS and e2e tests hold. Changing those is a separate, visible step.
- **MapLibre stays plain JavaScript.** Vue owns the panels, not the map: `map.js` ends up holding only the map and its layers, behind a small API the panels call.
- **No state library yet.** Each island has its own `reactive` store. Pinia comes in when two islands need to share state.

## Consequences

- The page carries Vue's runtime from the first island on: about 28 KB gzipped, in its own content-hashed module bundle.
- During the move there are two styles in the codebase. `viewer.js` is the seam between them; it shrinks as more moves to Vue.
- Values render as text by default, so the escaping bugs of hand-built HTML go away panel by panel.
- The dev stack still serves the watch build (`npm run dev`), with no hot reload. Vite's dev server can come later, once more of the page is modules.
