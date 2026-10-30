// The Admin Console globals Vue code reads, in one place (DIC-2389, ADR 0017): the admin
// page's counterpart of viewer.js. Read at call time, never at import.
const w = globalThis;

/** The Django API the console reads and writes (window.ADMIN_API overrides it, for testing). */
export const apiBase = () => w.ADMIN_API || '/api';

/** The county whose config the console edits. */
export const countyKey = () => w.PV_COUNTY_KEY || 'vanburen';

/** Who saves and publishes, as the config store records it. */
export const author = () => w.PV_ADMIN_USER || 'console';

/** The Map Buddy service's base URL (pv-endpoints.js), where the explainer plugins live. */
export const mapBuddyBase = () => (w.PV_ENDPOINTS ? w.PV_ENDPOINTS.mapBuddyBase() : (w.MAP_BUDDY_API || '/map-buddy-api'));

/** The engine's manifest hooks (engine/window-hooks.js), or null when the engine isn't on the page. */
export const manifestAssembler = () => w.ISV_MANIFEST_ASSEMBLE || null;
export const manifestLoader = () => w.ISV_LOAD_MANIFEST || null;
export const themeComposer = () => w.ISV_THEME_COMPOSER_CORE || null;

/** The baked county manifest (county-config.js), shown until /config answers. */
export const bakedConfig = () => w.COUNTY || {};

/** sessionStorage, read at call time (pv-storage-guard.js may stand in for a blocked one). */
export const session = () => w.sessionStorage;

/** localStorage, read at call time (the draft preview hands the viewer its config there). */
export const local = () => w.localStorage;
