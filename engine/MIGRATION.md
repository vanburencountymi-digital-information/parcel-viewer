# A3 — Global bus → injected AppContext (strangler-fig migration)

> **Status:** foundation landed (increment 1). The bus is NOT removed — this is an
> incremental, no-big-bang migration (§4 prime directive). PV and parcel-studio stay
> green at every step.

## The shape

| Today (global discovery) | Target (injection) |
|---|---|
| `window.PS_MAP` | `ctx.map` |
| `window.COUNTY` | `ctx.config` |
| `window.PS_STATE` | `ctx.state` |
| `window.PV_PREFS` | `ctx.prefs` |
| `window.PS_PARCEL_INDEX` | `ctx.sourceIndex` |
| ad-hoc callbacks / polling | `ctx.bus.on('selection-changed', …)` |

`ctx` is `window.PS_CONTEXT`, built once in
[frontend/public/js/pv-app-context.js](../frontend/public/js/pv-app-context.js) from the
live globals via **lazy getters**. Because the getters return the same underlying
objects the globals point at, `ctx.map === window.PS_MAP` at all times — so swapping a
read changes nothing at runtime.

## Why this is safe (strangler-fig)

1. The bridge **adds** `PS_CONTEXT`; it removes nothing. Old code and parcel-studio
   keep reading `window.PS_*`.
2. New code (and migrated reads) use `ctx.*`. Both see identical objects.
3. The engine core ([engine/app-context.js](app-context.js)) is **source-agnostic** and
   knows no global names — only the viewer bridge does. A CI guard
   ([test/guard-globals.test.js](test/guard-globals.test.js)) fails if any engine file
   reintroduces a `PS_*`/`ZIP_*` reference.

## How to migrate one file

1. At the top, take the context: `var ctx = root.PS_CONTEXT;` (or accept it as a param
   for testable modules).
2. Replace reads: `window.PS_MAP` → `ctx.map`, `window.COUNTY` → `ctx.config`, etc.
3. Replace any "is a parcel selected?" polling of `PS_STATE` with a `ctx.bus`
   subscription once A4 emits `selection-changed` / `active-feature-changed`.
4. Do **not** add new `window.PS_* = …` writes. If a value needs to be shared, put it
   behind the context/stores or emit it on the bus.
5. Verify the viewer still boots; bump the parcel-studio submodule and re-run its
   integration check (it depends on `PS_MAP`, `PS_STATE`, `PS_onParcelSelect`,
   `PS_selectParcel()`, `PS_DRAWING_TOOLS` — keep those intact until they're migrated
   in coordination with parcel-studio).

## Suggested order (most-referenced first, lowest risk first)

1. `COUNTY` → `ctx.config` (read-only config; ~32 refs, no behavior risk). **Start here.**
2. `PV_PREFS` → `ctx.prefs`.
3. `PS_PARCEL_INDEX` → `ctx.sourceIndex`.
4. `PS_STATE` → `ctx.state` + bus events — **this is A4** (SelectionManager); the
   selection state machine is extracted there, not by a blind find-replace.
5. `PS_MAP` → `ctx.map` (touches 11 files; do after A4 so the bus is the seam).

`PS_MAP`/`PS_STATE`/`PS_DRAWING_TOOLS` are the parcel-studio contract — migrate those
last and in lockstep with the submodule.
