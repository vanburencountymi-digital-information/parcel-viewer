// Staff sign-in for the Admin Console (DIC-2151, ADR 0013; a Vue island since DIC-2389).
//
// The Django API trades a staff password for a token (POST /auth/login), sent as
// "Authorization: Token …". It's kept in sessionStorage: a reload stays signed in, closing
// the tab signs out. Collaborators are injected so Vitest can drive it.
import { reactive } from 'vue';

export const AUTH_KEY = 'pv-admin-auth';

export function signInError(status) {
  if (status === 401) return 'Wrong username or password, or the account isn’t staff.';
  if (status === 422) return 'Enter a username and a password.';
  if (status === 429) return 'Too many attempts. Wait a minute and try again.';
  if (status === 404) return 'This API has no staff sign-in yet (it still uses the shared admin key).';
  return 'Couldn’t sign in (' + (status ? 'HTTP ' + status : 'no response') + ').';
}

export function createAuthStore({ fetch, apiBase, storage }) {
  const state = reactive({
    user: null,       // { token, username, expiry } while a staff user is signed in
    busy: false,      // a sign-in is in flight
    message: '',      // why the last sign-in failed, or "Signing in…"
  });
  // Told when someone signs in or out, so the console redraws the open module. Not told
  // when a write's 401 drops the sign-in (noteRefused): that module shows its own message.
  const listeners = new Set();
  const changed = () => listeners.forEach((fn) => fn());

  function read() {
    try {
      const a = JSON.parse(storage().getItem(AUTH_KEY) || 'null');
      return a && typeof a.token === 'string' && a.token ? a : null;
    } catch { return null; }
  }
  function set(a) {
    state.user = a;
    try {
      if (a) storage().setItem(AUTH_KEY, JSON.stringify(a));
      else storage().removeItem(AUTH_KEY);
    } catch { /* storage blocked: signed in for this page only */ }
  }

  const has = () => !!state.user;
  const headers = () => (state.user ? { Authorization: 'Token ' + state.user.token } : {});

  /** A 401 while signed in means the token expired or was revoked: forget it. */
  function noteRefused(status) {
    if (status === 401 && state.user) { set(null); return true; }
    return false;
  }

  async function signIn(username, password) {
    state.busy = true;
    state.message = 'Signing in…';
    let r;
    try {
      r = await fetch(apiBase() + '/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
    } catch { r = null; }
    if (!r || !r.ok) {
      state.busy = false;
      state.message = signInError(r ? r.status : 0);
      return false;
    }
    const j = await r.json();
    set({ token: j.token, username: j.user && j.user.username, expiry: j.expiry });
    state.busy = false;
    state.message = '';
    changed();
    return true;
  }

  function signOut() {
    const h = headers();
    set(null);
    changed();
    // Revoke the token on the server too; signed out locally either way.
    return fetch(apiBase() + '/auth/logout', { method: 'POST', headers: h }).catch(() => {});
  }

  /** On load: take a stored sign-in, and keep it only if the API still accepts its token. */
  async function check() {
    const stored = read();
    if (!stored) return;
    state.user = stored;
    let r;
    try {
      r = await fetch(apiBase() + '/auth/me', { headers: headers(), cache: 'no-cache' });
    } catch { return; }   // API unreachable: keep the sign-in; writes will say so
    if (r.status === 401 || r.status === 404) { set(null); changed(); return; }
    if (r.ok) {
      const j = await r.json();
      set({ token: stored.token, username: j.user && j.user.username, expiry: j.expiry });
    }
  }

  function onChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  return { state, has, headers, noteRefused, signIn, signOut, check, onChange };
}
