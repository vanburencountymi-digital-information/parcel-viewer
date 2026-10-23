// The Admin Console globals Vue code reads, in one place (DIC-2389, ADR 0017): the admin
// page's counterpart of viewer.js. Read at call time, never at import.
const w = globalThis;

/** The Django API the console reads and writes (window.ADMIN_API overrides it, for testing). */
export const apiBase = () => w.ADMIN_API || '/api';

/** The county whose config the console edits. */
export const countyKey = () => w.PV_COUNTY_KEY || 'vanburen';

/** Who saves and publishes, as the config store records it. */
export const author = () => w.PV_ADMIN_USER || 'console';

/** The baked county manifest (county-config.js), shown until /config answers. */
export const bakedConfig = () => w.COUNTY || {};

/** The modules admin.js still draws ({ modules, attach }), or null if it didn't load. */
export const legacyModules = () => w.PV_ADMIN_LEGACY || null;

/** sessionStorage, read at call time (pv-storage-guard.js may stand in for a blocked one). */
export const session = () => w.sessionStorage;

/** localStorage, read at call time (the draft preview hands the viewer its config there). */
export const local = () => w.localStorage;
