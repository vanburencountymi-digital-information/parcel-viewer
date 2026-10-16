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

/** The visitor's saved display preferences (PV_PREFS, via the app context), or null. */
export const prefs = () => (w.PS_CONTEXT && w.PS_CONTEXT.prefs) || w.PV_PREFS || null;

/** The parcel shown in the info panel ({ id, pin, … }), or null. */
export const selectedParcel = () => (w.PS_STATE && w.PS_STATE.parcel) || null;

/** Protected-county access notes and withheld checks (pv-access.js, ADR 0015). */
export const access = () => w.PV_ACCESS || null;

/** Esc, focus and Tab handling for overlay dialogs (pv-dialog.js). */
export const dialog = () => w.PV_DIALOG || null;

/** The engine's capability registry (ISV.invoke), with the capabilities registered at boot. */
export const isv = () => w.ISV || null;

/** The engine's explainer core: fact assembly, description classifier, PIN breakdown. */
export const explainerCore = () => w.ISV_EXPLAINER_CORE || null;

/** The engine's ledger core: categories and the display model. */
export const ledgerCore = () => w.ISV_LEDGER_CORE || null;

/** The Map Buddy service's base URL (pv-endpoints.js; the same service the explainers narrate from). */
export const mapBuddyBase = () => (w.PV_ENDPOINTS ? w.PV_ENDPOINTS.mapBuddyBase() : (w.MAP_BUDDY_API || '/map-buddy-api'));

/** The AI-mode controller (pv-ai-mode.js): isOn() is the visitor's choice, isEffective() adds "reachable". */
export const aiMode = () => w.PV_AI_MODE || null;

/** Print and download of standalone documents (pv-doc.js). */
export const doc = () => w.PV_DOC || null;

/** The engine's cohort-analyze core (engine/browser.js). */
export const cohortCore = () => w.ISV_COHORT_ANALYZE_CORE || null;

/** The map side of the Selection Tools pane (map.js): the selection, gestures, highlights. */
export const selectMap = () => w.PS_SELECT_MAP || null;

/** The map side of the Drawing tab (drawing/drawing-tools.js): tools, style, subscribe. */
export const drawTools = () => w.PS_DRAWING_TOOLS || null;

/** The drawings and their layer groups (drawing/annotation-store.js). */
export const annotations = () => w.PS_ANNOTATION_STORE || null;

/** Undo and redo over the drawings (drawing/undo-redo.js): canUndo, canRedo, undo(), redo(). */
export const undoRedo = () => w.PS_UNDO_REDO || null;

/** Snapping while drawing (drawing/snapping-engine.js): config, configure(). */
export const snapping = () => w.PS_SNAPPING_ENGINE || null;

/** Turf, for geometry (bundled from npm as a classic library). */
export const turf = () => w.turf || null;
