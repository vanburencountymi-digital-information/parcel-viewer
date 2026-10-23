// The Admin Console's staff sign-in as a Vue island (DIC-2389): mounts inside #ac-auth.
// Publishes window.PV_ADMIN_AUTH, which admin.js reads for every API call (headers,
// noteRefused) and to redraw the open module when someone signs in or out (onChange).
import { createApp } from 'vue';
import * as admin from '../shared/admin.js';
import { createAuthStore } from './auth.js';
import StaffSignIn from './StaffSignIn.vue';

export function mountStaffSignIn(doc = document) {
  const host = doc.getElementById('ac-auth');
  if (!host) return null;
  const store = createAuthStore({
    fetch: (...a) => globalThis.fetch(...a),
    apiBase: admin.apiBase,
    storage: admin.session,
  });
  createApp(StaffSignIn, { store }).mount(host);
  // Takes a stored sign-in at once (so admin.js's first render sees it), then checks it.
  store.check();
  const { has, headers, noteRefused, onChange } = store;
  globalThis.PV_ADMIN_AUTH = { has, headers, noteRefused, onChange, user: () => store.state.user };
  return store;
}
