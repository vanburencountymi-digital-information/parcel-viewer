// The Admin Console globals Vue code reads, in one place (DIC-2389, ADR 0017): the admin
// page's counterpart of viewer.js. Read at call time, never at import.
const w = globalThis;

/** The Django API the console reads and writes (window.ADMIN_API overrides it, for testing). */
export const apiBase = () => w.ADMIN_API || '/api';

/** sessionStorage, read at call time (pv-storage-guard.js may stand in for a blocked one). */
export const session = () => w.sessionStorage;
