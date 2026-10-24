// The Admin Console's Vue entry (DIC-2389, ADR 0017): the admin page's counterpart of
// main.js.
//
// Loaded as <script type="module"> at the end of admin/index.html. A module runs once the
// page is parsed, after every classic script: admin.js has registered its modules
// (PV_ADMIN_LEGACY) by then. Each island mounts on its own, so one that throws doesn't
// stop the others.
import { mountAdminConsole } from './admin-console/index.js';

const ISLANDS = {
  'admin-console': mountAdminConsole,
};

for (const [name, mount] of Object.entries(ISLANDS)) {
  try {
    mount();
  } catch (err) {
    // As a throwing classic script would: the error reaches pv-error-beacon.js.
    globalThis.reportError(new Error(`Vue island "${name}" failed to mount`, { cause: err }));
  }
}
