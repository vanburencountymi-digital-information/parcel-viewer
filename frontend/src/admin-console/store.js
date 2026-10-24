// The Admin Console's config and its draft (DIC-465 read, DIC-464/466 edit; moved from
// admin.js in DIC-2389): which module is open, the live config, and the shared
// edit → save → publish → history → rollback flow every editable module uses.
// Collaborators are injected so Vitest can drive it.
//
// The state is shallowReactive: the shell reacts to which module is open, editing, and a
// newly loaded config, while the config and draft objects themselves stay plain, so
// the editors can change them in place and the engine can clone them. `rev` counts the
// editors' changes to the draft, for a view that shows something derived from it (a
// list that gained a row, a field that depends on another).
import { shallowReactive } from 'vue';
import * as draftOps from './draft.js';

const PREVIEW_KEY = 'pv-config-preview';

export function createConsoleStore({ fetch, apiBase, auth, countyKey, author, fallback, local, open }) {
  const state = shallowReactive({
    active: null,        // the open module's id
    config: fallback || {},
    source: 'fallback',  // 'api' once /config answered
    editing: false,
    draft: null,         // a copy of the config while editing
    rev: 0,              // bumped on each setDraft / addRow / removeRow
  });
  const configPath = (rest) => '/config/' + countyKey + rest;

  /** What the open module shows: the draft while editing, else the live config. */
  const current = () => (state.editing ? (state.draft || {}) : (state.config || {}));

  /** The runtime /config API when reachable, else keep the baked fallback (county-config.js). */
  async function loadConfig() {
    try {
      const r = await fetch(apiBase() + '/config', { cache: 'no-cache' });
      if (!r.ok) return;
      const cfg = await r.json();
      if (cfg && typeof cfg === 'object' && !cfg.error) { state.config = cfg; state.source = 'api'; }
    } catch { /* keep the baked fallback */ }
  }

  /** Opens a module; switching drops any edit in progress. */
  function show(id) {
    if (id !== state.active) { state.editing = false; state.draft = null; }
    state.active = id;
  }

  // An admin call with the staff token. Resolves { ok, status, body, expired } and never
  // rejects, so the UI can show a clean message (incl. 503 "not provisioned").
  async function request(method, path, body) {
    const headers = { ...auth.headers(), 'Content-Type': 'application/json' };
    let r;
    try {
      r = await fetch(apiBase() + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    } catch (e) {
      return { ok: false, status: 0, body: { detail: String((e && e.message) || e) } };
    }
    const expired = auth.noteRefused(r.status);
    let j;
    try { j = await r.json(); } catch { j = {}; }
    return { ok: r.ok, status: r.status, body: j, expired };
  }

  function writeErr(res) {
    if (res.status === 503) return 'Editing is built but not yet provisioned in this environment (writable store — DIC-464 / DIC-400). Save will work once the store is live.';
    if (res.status === 401) {
      return res.expired
        ? 'Your staff sign-in has expired. Sign in again to save.'
        : 'Sign in as staff to save: admin auth required.';
    }
    // 403: not staff, or no access to this county (the API says which).
    if (res.status === 403) return 'Not allowed: ' + ((res.body && res.body.detail) || 'this account can’t change this county’s config.');
    return (res.body && res.body.detail) || ('Request failed (HTTP ' + res.status + ').');
  }
  const done = (ok, message, extra) => ({ ok, message, ...extra });

  /**
   * Starts editing a copy of the live config, then continues the server's saved draft if
   * there is one. Resolves true when that draft replaced the copy (redraw the editor).
   */
  async function edit() {
    state.editing = true;
    state.draft = draftOps.clone(state.config);
    const res = await request('GET', configPath('/draft'));
    if (res.ok && res.body && !res.body.error && state.editing) { state.draft = res.body; return true; }
    return false;
  }

  /** Editing without the Edit button (e.g. adding a discovered layer): make sure there's a draft. */
  function ensureDraft() {
    if (!state.draft) state.draft = draftOps.clone(state.config);
    state.editing = true;
    return state.draft;
  }

  function cancel() {
    state.editing = false;
    state.draft = null;
    try { local().removeItem(PREVIEW_KEY); } catch { /* storage blocked */ }   // drop any stale preview
  }

  // Local draft preview (DIC-512): push the in-memory draft to the viewer via
  // localStorage, no server write. The viewer (style-preview.js) merges it over
  // window.COUNTY and shows a banner. Opens or focuses a named viewer tab; if it's
  // already open, its storage listener reloads it with the new draft.
  function preview() {
    try {
      local().setItem(PREVIEW_KEY, JSON.stringify(state.draft || state.config));
      open('/demo/', 'pvPreview');
      return done(true, 'Draft sent to the viewer preview (opened /demo/). Edit & Preview again to refresh it.');
    } catch (e) {
      return done(false, 'Could not open preview: ' + ((e && e.message) || e));
    }
  }

  async function save() {
    const res = await request('PUT', configPath('/draft'), { payload: state.draft, author });
    return res.ok ? done(true, 'Draft saved.') : done(false, writeErr(res));
  }

  /** Saves the draft, publishes it as a new version, and returns to the (reloaded) live config. */
  async function publish(note = 'Published from console') {
    const saved = await request('PUT', configPath('/draft'), { payload: state.draft, author });
    if (!saved.ok) return done(false, writeErr(saved));
    const res = await request('POST', configPath('/publish'), { author, note });
    if (!res.ok) return done(false, writeErr(res));
    await loadConfig();
    state.editing = false;
    state.draft = null;
    return done(true, 'Published version ' + res.body.version + '.');
  }

  async function versions() {
    const res = await request('GET', configPath('/versions'));
    if (!res.ok) return done(false, writeErr(res), { versions: [] });
    return done(true, '', { versions: (res.body && res.body.versions) || [] });
  }

  async function rollback(version) {
    const res = await request('POST', configPath('/rollback'), { version, author });
    if (!res.ok) return done(false, writeErr(res));
    await loadConfig();
    return done(true, 'Restored v' + version + ' as version ' + res.body.version + '.');
  }

  // The editors' field changes, on the draft. Ignored unless editing.
  function changed(op) {
    if (!state.editing) return;
    op(state.draft);
    state.rev++;
  }
  const setDraft = (path, value) => changed((d) => draftOps.setPath(d, path, value));
  const addRow = (path) => changed((d) => draftOps.arrayAdd(d, path));
  const removeRow = (path, idx) => changed((d) => draftOps.arrayRemove(d, path, idx));
  const rowsAt = (path) => draftOps.arrayAt(ensureDraft(), path);

  return {
    state, countyKey, apiBase, current, loadConfig, show, request, writeErr,
    edit, ensureDraft, cancel, preview, save, publish, versions, rollback,
    setDraft, addRow, removeRow, rowsAt, clone: draftOps.clone,
  };
}
