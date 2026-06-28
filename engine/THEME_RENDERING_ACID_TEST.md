# ISV Acid Test — "the engine renders an arbitrary theme"

The keystone vision in one sentence: **ISV is the spatial engine; a viewer (PV, ZIP, …) is
a *theme* on top of it.** This doc makes that claim *checkable* instead of aspirational. It is
the definition of done for "PV is only a theme," the milestones that lead there, and the exact
external prerequisites needed to run the proof.

Companion to `HANDOFF.md` (status), `DECISIONS.md` (D1–D13), `README.md` (engine contract).

---

## The acid test (the one check that proves the vision)

> Take the **same deployed frontend bundle**, point it at a **different theme manifest**, and
> get a **correct, working viewer for that domain — with zero theme-specific frontend code in
> the path.** Repeat with a *third*, synthetic theme the codebase has never seen, and it still
> works (no hardcoded PV/ZIP special-casing).

If that holds, PV is genuinely "config on an engine." Until it holds, PV is "a frontend that
reads a manifest" — real progress, but not the vision.

---

## Why we're not there yet (the honest gap)

- **Capability layer — DONE.** `engine/` is source-agnostic and enforced (`engine-smoke.test.js`
  fails if the word "parcel" appears in the engine; `guard-globals.test.js` forbids `PS_*`/`ZIP_*`
  reads in engine code). A new theme gets explainer / ledger / cohort-analyze / citations for free
  by pointing field-config at different columns.
- **Viewer-shell layer — NOT YET.** What the user looks at (map init, panels, selection, the
  `PS_*` stack in `frontend/public/js/map.js`) is still PV's frontend. It now *reads* the manifest
  for branding/map/sources/capabilities, but it is not the engine *rendering* a theme.
- **The tell:** no second theme renders through the same shell. `lockport-township.json` validates
  and loads as an object, but no engine code turns it into a zoning viewer; ZIP still has its own
  `ZIP_*` fork.

Reading config from a manifest ≠ being a theme on an engine. The latter requires the shell to be
theme-driven enough that a new theme needs **no new frontend code**.

---

## Tiered definition of done

Each tier is a strictly stronger claim. Tier status is the honest current state.

### Tier 0 — "the contract exists" — ✅ DONE (verifiable here)
- [x] One manifest schema; ≥2 real manifests validate against it (`themes.test.js`).
- [x] Engine core is source-agnostic (`engine-smoke.test.js`) and global-bus-free (`guard-globals.test.js`).
- [x] The viewer can boot from a theme **file** (`?theme=` / `pv-theme-id`), COUNTY fallback (`pv-manifest.js`).
- [x] Capability/source/branding/map reads resolve from the manifest (keystone Phases 1–3, 2B).

### Tier 1 — "no hidden PV coupling" — ◐ PARTIAL (mostly verifiable here)
The engine must accept a theme it has never seen without special-casing.
- [x] A **synthetic third theme** (neither PV nor ZIP) round-trips `loadManifest`, canonicalizes its
      tenant, and resolves capabilities generically — see `themes.test.js`
      ("engine accepts an arbitrary third theme"). Proves it's not two hardcoded cases.
- [x] The live shell reads its theme-varying CONFIG from the manifest, not `window.COUNTY`
      (AC7, `pv-app-context.js`): `ctx.config` is a view = COUNTY base + the manifest's passthrough
      blocks (labels/styling/parcelNumber/forms/endpoints/integrations/access/state). Strangler-safe
      by construction — for VBC the view deep-equals COUNTY (zero change); a different theme's blocks
      drive config (live-verified: a changed label flows through ctx.config, COUNTY untouched).
- [~] Popup config manifest-drivable (DIC-407): the parcel popup renders through the engine AND its
      config now resolves from the manifest source (`map.js _parcelPopupCfg()`) when a theme ships rich
      popup sections, in-file config as fallback — seam in + live-verified. **Remaining (post-deploy):**
      move the canonical config out of map.js into COUNTY/manifest + de-dupe; formatters stay viewer-owned.
- [ ] A3 contract globals (`PS_STATE`/`PS_MAP`/drawing) migrated to injected context; guard forbids
      new contract-global reads in the shell. Ticket: DIC-568. **Gated:** needs parcel-studio runnable.

### Tier 2 — "a second theme renders (stub data)" — ✗ NOT STARTED
- [ ] The **same bundle** boots `lockport-township` and renders its sources/capabilities/branding,
      with **no `ZIP_*` fork code loaded**, even against empty/stub data (proves zero PV coupling
      in the shell). **Gated:** Tier-1 A3 + a registered bootable second theme.

### Tier 3 — "a second theme renders (real data, full features)" — ✗ NOT STARTED
- [ ] Lockport zoning/parcel data in db-dice → the zoning theme renders real features; ordinance
      citations + cohort analysis work via config only. Tickets: DIC-523 (ZIP-on-engine), DIC-570
      (ParcelStore data). **Gated:** ZIP stack runnable + Lockport data migration.

---

## Acceptance criteria (binary, with the enforcing check)

| # | Criterion | Enforced by | State |
|---|-----------|-------------|-------|
| AC1 | One schema, ≥2 manifests validate | `themes.test.js` | ✅ |
| AC2 | Engine core mentions no domain noun | `engine-smoke.test.js` | ✅ |
| AC3 | Engine reads no `PS_*`/`ZIP_*` global | `guard-globals.test.js` | ✅ |
| AC4 | Arbitrary (3rd) theme accepted generically | `themes.test.js` (synthetic) | ✅ |
| AC5 | Viewer boots from a theme FILE | live `?theme=` + `pv-manifest.js` | ✅ |
| AC6 | Capabilities/surfaces gate from manifest | `pv-capabilities.js` + `feature-flags.test.js` | ✅ |
| AC7 | Shell config fully manifest-driven (no COUNTY) | `pv-app-context.js` config view + deep-equal invariant (live) | ✅ |
| AC8 | A3 contract globals injected, not global | DIC-568 + guard expansion | ⬜ (gated) |
| AC9 | 2nd theme renders through same bundle (stub) | live boot of lockport via same bundle | ⬜ (gated) |
| AC10 | 2nd theme renders real data + capabilities | live + db-dice data | ⬜ (gated) |

**The vision is "done" when AC1–AC10 are all ✅ and a synthetic theme passes AC9.** Today: **AC1–AC7
green** (the manifest now drives capabilities, sources, branding, map, AND config); AC8 (A3 contract
globals) + AC9–AC10 (a 2nd theme renders) are externally gated. **Tier 1 is essentially closed** —
the only remaining Tier-1 item is the A5 rich-popup render path (DIC-407), a smaller grind.

---

## Minimum runnable environment to RUN the proof

The remaining tiers can't be *verified* in this dev environment because the inputs aren't runnable
here. To unblock, we need:

1. **parcel-studio submodule checked out + its integration runnable** — required to migrate the A3
   contract globals (`PS_STATE`/`PS_MAP`/drawing) safely and re-verify each batch (AC8). Today the
   submodule pin lags and isn't runnable in this checkout.
2. **ZIP/zip-poc stack runnable locally** — its frontend + dev server, so the same engine bundle can
   attempt to boot the zoning theme (AC9). Today ZIP is only present as a pinned manifest.
3. **Lockport data in db-dice** — zoning + parcel geometry/assessment for Lockport Township, plus its
   Martin tile functions, so the zoning theme has real sources to render (AC10). Drake deferred this
   pending a DB-shape decision (`assessing.parcels` + county discriminator vs per-county tables) and
   the Lockport ETL. Blocks ParcelStore (DIC-570) and Tier 3.
4. **A registered bootable second theme** — flip `engine/themes/index.json` `lockport-township.bootable`
   to `true` only once items 2–3 let it actually render (today it is correctly `false`, which keeps the
   theme chooser gated/hidden).

When 1–4 are available, the acid test is: register lockport bootable → load the SAME bundle with
`?theme=lockport-township` → confirm a working zoning viewer with no `ZIP_*` code in the path.

---

## What is verifiable HERE, now

- Tier 0 (all green) and **AC4** — the synthetic-arbitrary-theme harness check — run in CI with no
  external deps. That converts "the engine isn't hardcoded to PV/ZIP" from a claim into a test.
- **AC7 — DONE** (`5c437a0`): `ctx.config` is a COUNTY-base + manifest-passthrough view; the manifest
  now drives the viewer's config, deep-equal-safe for VBC. Tier 1 is essentially closed.
- The remaining in-repo item is **DIC-407** (A5 rich-popup render path → manifest) — a smaller grind,
  doable here. After that, the next moves (AC8–AC10) wait on the runnable-environment list above.

The rest (AC8–AC10) waits on the runnable-environment list above.
