// Parcel search (GET /search, the server's omni-search over parcel numbers, owners and
// addresses) as an ARIA combobox (DIC-381): the query, the results, which one is active, and
// what the screen-reader status says. Collaborators are injected so Vitest can drive it.
import { reactive } from 'vue';

const MIN_CHARS = 2;
const DEBOUNCE_MS = 250;

export function createSearchStore({ fetch, apiBase, noteAccess = (d) => d, select, timers = globalThis }) {
  const state = reactive({
    query: '',
    results: [],      // [{ id, pin, municipality, owner_name, address }]
    message: '',      // "No matches found", or an error (error: true)
    error: false,
    open: false,      // the results list shows
    active: -1,       // the highlighted option
    status: '',       // announced politely (role="status")
  });
  let timer = null;
  let controller = null;
  const hasContent = () => state.results.length > 0 || !!state.message;

  function clear() {
    Object.assign(state, { results: [], message: '', error: false, open: false, active: -1, status: '' });
  }

  /** The input changed: search after a pause, or clear below two characters. */
  function input(value) {
    state.query = value;
    const q = value.trim();
    timers.clearTimeout(timer);
    if (q.length < MIN_CHARS) {
      // Also drop the pending or in-flight search, or its results reappear after clearing.
      if (controller) { controller.abort(); controller = null; }
      clear();
      return;
    }
    timer = timers.setTimeout(() => run(q), DEBOUNCE_MS);
  }

  async function run(q) {
    if (controller) controller.abort();
    const mine = (controller = new AbortController());
    let data;
    try {
      const r = await fetch(`${apiBase()}/search?q=${encodeURIComponent(q)}&limit=25`, { signal: mine.signal });
      if (!r.ok) { const e = new Error(`search HTTP ${r.status}`); e.status = r.status; throw e; }
      data = noteAccess(await r.json());
    } catch (err) {
      if (err && err.name === 'AbortError') return;   // superseded by a newer keystroke
      // A failed search used to be swallowed as if aborted, so the user saw nothing (DIC-1856).
      showError(err && err.status === 429
        ? 'Too many searches — please wait a moment and try again.'
        : 'Search is unavailable right now. Please try again.');
      return;
    }
    if (mine !== controller) return;                  // a newer search started meanwhile
    showResults((data && data.results) || []);
  }

  function showResults(results) {
    Object.assign(state, { results, error: false, open: true, active: -1 });
    if (!results.length) {
      state.message = 'No matches found';
      state.status = 'No matches found';
      return;
    }
    state.message = '';
    state.status = `${results.length}${results.length === 1 ? ' result' : ' results'} found, use up and down arrow keys to navigate`;
  }

  function showError(msg) {
    Object.assign(state, { results: [], message: msg, error: true, open: true, active: -1, status: msg });
  }

  function hide() { state.open = false; state.active = -1; }

  /** The input got focus: show what's there from the last search. */
  function reveal() { if (hasContent()) state.open = true; }

  function pick(idx) {
    const r = state.results[idx];
    if (!r) return false;
    select(r.id);
    hide();
    return true;
  }

  /** The combobox keys. Returns true when it handled the key (the caller prevents default). */
  function key(name) {
    const n = state.results.length;
    const listing = state.open && n > 0;
    switch (name) {
      case 'ArrowDown': if (listing) { state.active = (state.active + 1) % n; return true; } return false;
      case 'ArrowUp': if (listing) { state.active = (state.active - 1 + n) % n; return true; } return false;
      case 'Home': if (listing) { state.active = 0; return true; } return false;
      case 'End': if (listing) { state.active = n - 1; return true; } return false;
      case 'Enter': return listing && state.active >= 0 ? pick(state.active) : false;
      default: return false;
    }
  }

  /** Esc: close the list if it's open; otherwise clear the query. Returns 'hid' or 'cleared'. */
  function escape() {
    if (state.open) { hide(); return 'hid'; }
    timers.clearTimeout(timer);
    if (controller) { controller.abort(); controller = null; }
    state.query = '';
    clear();
    return 'cleared';
  }

  return { state, input, hide, reveal, pick, key, escape, hasContent, isOpen: () => state.open };
}
