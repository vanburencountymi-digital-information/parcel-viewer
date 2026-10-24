// The Admin Console as a Vue island (DIC-2389): the shell (nav, top bar, staff sign-in)
// mounts inside #ac-app. The modules are still admin.js's: it registers them as
// window.PV_ADMIN_LEGACY ({ modules, attach }), and attach() hands it the console store,
// so its editors read and write the same config and draft.
//
// Publishes window.PV_ADMIN_AUTH (the staff sign-in: has, headers, noteRefused, onChange)
// and window.PV_ADMIN (getState: the console state, for automated checks).
import { createApp } from 'vue';
import * as admin from '../shared/admin.js';
import AdminConsole from './AdminConsole.vue';
import { createAuthStore } from './auth.js';
import { createConsoleStore } from './store.js';

export function mountAdminConsole(doc = document) {
  const host = doc.getElementById('ac-app');
  if (!host) return null;
  const fetch = (...a) => globalThis.fetch(...a);

  const auth = createAuthStore({ fetch, apiBase: admin.apiBase, storage: admin.session });
  // Takes a stored sign-in at once (so the first render sees it), then checks it.
  auth.check();
  const { has, headers, noteRefused, onChange } = auth;
  globalThis.PV_ADMIN_AUTH = { has, headers, noteRefused, onChange, user: () => auth.state.user };

  const store = createConsoleStore({
    fetch,
    apiBase: admin.apiBase,
    auth,
    countyKey: admin.countyKey(),
    author: admin.author(),
    fallback: admin.bakedConfig(),
    local: admin.local,
    open: (...a) => globalThis.open(...a),
  });
  globalThis.PV_ADMIN = { getState: () => store.state };

  const legacy = admin.legacyModules();
  if (legacy) legacy.attach(store);
  createApp(AdminConsole, { store, auth, modules: legacy ? legacy.modules : [] }).mount(host);
  return store;
}
