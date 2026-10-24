// The Admin Console's staff sign-in (DIC-2389; was HTML built by admin.js). The API is
// faked here; the e2e suite drives it with stubbed auth routes (admin-console.spec.js).
import { mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import { AUTH_KEY, createAuthStore, signInError } from './auth.js';
import StaffSignIn from './StaffSignIn.vue';

const ok = (json) => ({ ok: true, status: 200, json: async () => json });
const refused = (status) => ({ ok: false, status, json: async () => ({}) });

function memoryStorage(init = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}

function setup({ replies = [], stored } = {}) {
  const storage = memoryStorage(stored ? { [AUTH_KEY]: JSON.stringify(stored) } : {});
  const fetch = vi.fn(async () => {
    const next = replies.shift();
    if (next instanceof Error) throw next;
    return next || ok({});
  });
  const store = createAuthStore({ fetch, apiBase: () => '/api', storage: () => storage });
  return { store, fetch, storage };
}

const LOGIN = { token: 't-1', user: { username: 'tester' }, expiry: '2099-01-01' };

describe('auth store', () => {
  it('signing in stores the token and tells the console; headers carry it', async () => {
    const { store, fetch, storage } = setup({ replies: [ok(LOGIN)] });
    const changed = vi.fn();
    store.onChange(changed);

    expect(await store.signIn('tester', 'pw')).toBe(true);

    expect(fetch).toHaveBeenCalledWith('/api/auth/login', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ username: 'tester', password: 'pw' }),
    }));
    expect(store.has()).toBe(true);
    expect(store.headers()).toEqual({ Authorization: 'Token t-1' });
    expect(JSON.parse(storage.getItem(AUTH_KEY))).toEqual({ token: 't-1', username: 'tester', expiry: '2099-01-01' });
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it('a refused or failed sign-in says why and stays signed out', async () => {
    const { store } = setup({ replies: [refused(401), refused(429), new TypeError('offline')] });
    await store.signIn('a', 'b');
    expect(store.state.message).toBe(signInError(401));
    await store.signIn('a', 'b');
    expect(store.state.message).toMatch(/Too many attempts/);
    await store.signIn('a', 'b');
    expect(store.state.message).toBe('Couldn’t sign in (no response).');
    expect(store.has()).toBe(false);
    expect(store.state.busy).toBe(false);
  });

  it('signing out forgets the token, tells the console, and revokes it with the old token', async () => {
    const { store, fetch, storage } = setup({ replies: [ok(LOGIN)] });
    await store.signIn('tester', 'pw');
    const changed = vi.fn();
    store.onChange(changed);

    await store.signOut();

    expect(store.has()).toBe(false);
    expect(storage.getItem(AUTH_KEY)).toBeNull();
    expect(changed).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenLastCalledWith('/api/auth/logout', { method: 'POST', headers: { Authorization: 'Token t-1' } });
  });

  it('a stored sign-in is taken at once, then kept, dropped or refreshed by /auth/me', async () => {
    const kept = setup({ stored: { token: 's', username: 'old' }, replies: [ok({ user: { username: 'new' }, expiry: 'e' })] });
    const p = kept.store.check();
    expect(kept.store.has()).toBe(true);   // before the check answers: the first render sees it
    await p;
    expect(kept.store.state.user).toEqual({ token: 's', username: 'new', expiry: 'e' });

    const dropped = setup({ stored: { token: 's' }, replies: [refused(401)] });
    const changed = vi.fn();
    dropped.store.onChange(changed);
    await dropped.store.check();
    expect(dropped.store.has()).toBe(false);
    expect(dropped.storage.getItem(AUTH_KEY)).toBeNull();
    expect(changed).toHaveBeenCalledTimes(1);

    const offline = setup({ stored: { token: 's', username: 'old' }, replies: [new TypeError('offline')] });
    await offline.store.check();
    expect(offline.store.state.user.username).toBe('old');
  });

  it('a write refused with 401 drops the sign-in without redrawing the module', async () => {
    const { store, storage } = setup({ replies: [ok(LOGIN)] });
    await store.signIn('tester', 'pw');
    const changed = vi.fn();
    store.onChange(changed);

    expect(store.noteRefused(403)).toBe(false);
    expect(store.noteRefused(401)).toBe(true);
    expect(store.noteRefused(401)).toBe(false);   // already signed out

    expect(store.has()).toBe(false);
    expect(storage.getItem(AUTH_KEY)).toBeNull();
    expect(changed).not.toHaveBeenCalled();
  });

  it('ignores a stored value without a token, and works with storage blocked', async () => {
    const tokenless = setup({ stored: { username: 'x' } });
    await tokenless.store.check();
    expect(tokenless.store.has()).toBe(false);
    expect(tokenless.fetch).not.toHaveBeenCalled();
    const blocked = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); } };
    const store = createAuthStore({ fetch: async () => ok(LOGIN), apiBase: () => '/api', storage: () => blocked });
    await store.check();
    expect(store.has()).toBe(false);
    await store.signIn('tester', 'pw');
    expect(store.has()).toBe(true);
  });
});

describe('StaffSignIn', () => {
  it('submits the trimmed username; while waiting the button is disabled and says so', async () => {
    let answer;
    const { store, fetch } = setup();
    fetch.mockImplementationOnce(() => new Promise((r) => { answer = r; }));
    const w = mount(StaffSignIn, { props: { store } });

    await w.get('#ac-signin-user').setValue('  tester ');
    await w.get('#ac-signin-pass').setValue('pw');
    await w.get('#ac-signin').trigger('submit');

    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ username: 'tester', password: 'pw' });
    expect(w.get('button[type="submit"]').attributes('disabled')).toBeDefined();
    expect(w.get('#ac-signin-msg').text()).toBe('Signing in…');

    answer(refused(401));
    await vi.waitFor(() => expect(w.get('#ac-signin-msg').text()).toMatch(/Wrong username or password/));
    expect(w.get('button[type="submit"]').attributes('disabled')).toBeUndefined();
    expect(w.get('#ac-signin-pass').element.value).toBe('');
    expect(w.get('#ac-signin-user').element.value).toBe('  tester ');
  });

  it('signed in, shows who and a Sign out button; signing out brings back an empty form', async () => {
    const { store } = setup({ replies: [ok(LOGIN)] });
    const w = mount(StaffSignIn, { props: { store } });
    await w.get('#ac-signin-user').setValue('tester');
    await w.get('#ac-signin-pass').setValue('pw');
    await w.get('#ac-signin').trigger('submit');
    await vi.waitFor(() => expect(w.find('.ac-auth-who').exists()).toBe(true));
    expect(w.get('.ac-auth-who').text()).toBe('Signed in as tester');

    await w.get('#ac-signout').trigger('click');

    expect(w.find('.ac-auth-who').exists()).toBe(false);
    expect(w.get('#ac-signin-user').element.value).toBe('');
    expect(w.get('#ac-signin-pass').element.value).toBe('');
    expect(w.get('#ac-signin-msg').text()).toBe('');
  });

  it('keeps the labels and status the e2e suite and screen readers use', () => {
    const { store } = setup();
    const w = mount(StaffSignIn, { props: { store } });
    expect(w.get('label[for="ac-signin-user"]').text()).toBe('Username');
    expect(w.get('label[for="ac-signin-pass"]').text()).toBe('Password');
    expect(w.get('#ac-signin-pass').attributes('type')).toBe('password');
    expect(w.get('#ac-signin-msg').attributes('role')).toBe('status');
  });
});
