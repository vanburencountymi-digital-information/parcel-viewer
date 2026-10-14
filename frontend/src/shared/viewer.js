// The viewer globals Vue code reads, in one place (DIC-2389, ADR 0017).
//
// The page's classic scripts still share state through window.* hooks. Vue code reads
// them only through these functions, at call time (never at import), so a component
// never holds a stale copy and the names can change here alone as more of the viewer
// moves to Vue. Each returns a safe default when its script isn't on the page.
const w = globalThis;

export const apiBase = () => w.API_BASE || (w.PS_CONFIG && w.PS_CONFIG.API_BASE) || '/api';

/** Capability gating (pv-capabilities.js); default-on when gating isn't loaded. */
export const capEnabled = (id) => (w.PV_CAPS ? w.PV_CAPS.isEnabled(id) : true);

/** The county config view: the manifest's blocks over COUNTY (pv-app-context.js). */
export const countyConfig = () => (w.PS_CONTEXT && w.PS_CONTEXT.config) || w.COUNTY || {};

/** The parcel shown in the info panel ({ id, pin, … }), or null. */
export const selectedParcel = () => (w.PS_STATE && w.PS_STATE.parcel) || null;

/** Protected-county access notes and withheld checks (pv-access.js, ADR 0015). */
export const access = () => w.PV_ACCESS || null;

/** Esc, focus and Tab handling for overlay dialogs (pv-dialog.js). */
export const dialog = () => w.PV_DIALOG || null;

/** The engine's cohort-analyze core (engine/browser.js). */
export const cohortCore = () => w.ISV_COHORT_ANALYZE_CORE || null;

/** The map side of the Selection Tools pane (map.js): the selection, gestures, highlights. */
export const selectMap = () => w.PS_SELECT_MAP || null;

/** Turf, for geometry (bundled from npm as a classic library). */
export const turf = () => w.turf || null;
