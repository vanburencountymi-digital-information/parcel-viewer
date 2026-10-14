// Compare preset of the cohort-analyze capability (DIC-589): the set of 2–5 parcels to
// compare, and the table for it. The components render this state; window.PV_COMPARE
// (index.js) drives it for the parcel panel's menu and Map Buddy.
//
// The viewer is injected (globals, fetch, toast) so Vitest can drive it without a page.
import { reactive } from 'vue';
import { buildTable } from './table.js';

export const MAX = 5;
export const MIN = 2;

// A parcel for the set from a numeric id, a PIN string, or { id, pin } (Map Buddy passes PINs).
function normItem(x) {
  if (x && typeof x === 'object') return { id: x.id != null ? x.id : null, pin: x.pin || null };
  if (typeof x === 'number') return { id: x, pin: null };
  const s = String(x).trim();
  return /^\d+$/.test(s) ? { id: Number(s), pin: null } : { id: null, pin: s };
}

/** The key that removes a parcel: its id once known, else its PIN. */
export const itemKey = (p) => (p.id != null ? p.id : p.pin);

export function createCompareStore({ viewer, toast, fetch = (...a) => globalThis.fetch(...a) }) {
  const state = reactive({
    set: [],        // [{ id, pin }]
    table: null,    // buildTable()'s result, once loaded
    open: false,    // the table dialog is showing
  });

  const isEnabled = () => viewer.capEnabled('compare');
  const has = (id) => state.set.some((p) => String(p.id) === String(id));

  function add(id, pin) {
    if (!isEnabled() || id == null) return;
    if (has(id)) return;
    if (state.set.length >= MAX) { toast(`Compare holds up to ${MAX} parcels.`); return; }
    state.set.push({ id, pin: pin || null });
  }

  function addCurrent() {
    const pc = viewer.selectedParcel();
    if (!pc || pc.id == null) { toast('Select a parcel first, then add it to Compare.'); return; }
    add(pc.id, pc.pin);
    if (state.set.length < MIN) toast(`Added ${pc.pin || pc.id} — pick another parcel to compare.`);
  }

  // Match on id or PIN: Map Buddy adds parcels by PIN ({ id: null, pin }), while the
  // table's columns carry the numeric id from /cohort. Matching on id alone never removed
  // those, and the next render fetched them straight back (DIC-1873).
  function remove(key) {
    const k = String(key);
    state.set = state.set.filter((p) => String(p.id) !== k && String(p.pin) !== k);
  }

  function clear() { state.set = []; }

  function close() { state.open = false; }

  /** Loads the set's parcels from /cohort and opens the table. */
  async function show() {
    if (!isEnabled()) return;
    if (state.set.length < MIN) { toast(`Add at least ${MIN} parcels to compare.`); return; }
    const ids = [], pins = [];
    for (const p of state.set) { if (p.id != null) ids.push(p.id); else if (p.pin) pins.push(p.pin); }
    const selector = { type: 'explicit' };
    if (ids.length) selector.ids = ids;
    if (pins.length) selector.pins = pins;
    let data;
    try {
      const r = await fetch(viewer.apiBase() + '/cohort', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ selector }),
      });
      data = r.ok ? await r.json() : null;
    } catch {
      toast('Couldn’t reach the server to compare.');
      return;
    }
    const acc = viewer.access();
    if (acc) data = acc.note(data);
    if (!data || !data.features || !data.features.length) { toast('Couldn’t load those parcels.'); return; }
    // Learn the ids of parcels that were added by PIN, so later removals match.
    for (const f of data.features) {
      const pin = f.properties && (f.properties.pin || f.properties.parcel_no);
      for (const p of state.set) if (p.id == null && p.pin && pin && String(p.pin) === String(pin)) p.id = f.id;
    }
    state.table = buildTable(data, {
      core: viewer.cohortCore().core,
      labels: viewer.countyConfig().labels || {},
      isWithheld: acc ? (props) => acc.isWithheld(props) : undefined,
    });
    state.open = true;
  }

  /** Programmatic compare (Map Buddy): replace the set with `list` (if given), then show. */
  function open(list) {
    if (Array.isArray(list)) state.set = list.slice(0, MAX).map(normItem);
    return show();
  }

  /** A column's ×: drop that parcel, then re-show the rest, or close if too few remain. */
  function removeColumn(id) {
    remove(id);
    if (state.set.length >= MIN) return show();
    close();
  }

  return { state, isEnabled, has, add, addCurrent, remove, clear, open, show, close, removeColumn };
}
