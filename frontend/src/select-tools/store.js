// The Selection Tools pane's state and actions: which tool is armed, the attribute
// filter, the buffer around a seed parcel, and the selection's CSV. The map side (the
// selection itself, the box and lasso gestures, the highlights) is PS_SELECT_MAP in map.js.
//
// Its collaborators are injected so Vitest can drive it without a page or a map.
import { reactive, watch } from 'vue';
import { selectionCsv } from './csv.js';
import { filterFields, matchParcels } from './filter.js';

export const pinOf = (f) => f.properties.pin || f.properties.PIN;
const plural = (n, word) => `${n} ${word}${n !== 1 ? 's' : ''}`;

// The tools the Esc key and the active-tool bar exit.
const SPATIAL = new Set(['box', 'lasso', 'buffer']);

export function createSelectToolsStore({ map, turf, isWithheld = () => false, download, timers = globalThis }) {
  const state = reactive({
    tool: null,                    // 'box' | 'lasso' | 'filter' | 'buffer' | null
    selectedCount: map.selectionSize(),
    fields: [],                    // [{ key, label }] from the viewport index
    filter: { field: '', op: 'eq', value: '', note: '' },
    buffer: { seedPin: null, distance: '500', units: 'feet', live: true, includeSeed: true, note: '' },
  });
  const f = state.filter;
  const b = state.buffer;
  let seedGeom = null;             // kept out of reactive state: a parcel's full geometry
  let previewTimer = null;

  // ── Tools ──────────────────────────────────────────────────────────────
  /** Arms `tool`; arming the armed tool again (or null) exits it. */
  function setTool(tool) {
    if (state.tool === tool) tool = null;
    if (state.tool === 'buffer' && tool !== 'buffer') clearBuffer();
    state.tool = tool;
    map.setTool(tool);
    // Seed from the parcel already on screen; a map click still re-seeds.
    if (tool === 'buffer') {
      const cur = map.activeParcel();
      if (cur) seedBuffer(cur);
    }
  }

  /** Esc exits a spatial tool; returns whether it did. */
  function escape() {
    if (!SPATIAL.has(state.tool)) return false;
    setTool(null);
    return true;
  }

  // ── Selection ──────────────────────────────────────────────────────────
  function selectionChanged(count) { state.selectedCount = count; }

  function clearSelection() { map.clear(); }

  function downloadCsv() {
    const records = map.selectedRecords();
    if (!records.length) return;
    download(selectionCsv(records), `parcels_${records.length}_selected.csv`);
    // Rows past a Protected county's daily detail limit (ADR 0015) have their owner and
    // value cells empty; the file's details_withheld column marks them. Say so.
    const withheld = records.filter((r) => isWithheld(r)).length;
    if (withheld) {
      map.notify(`${withheld} of ${records.length} parcels were exported without owner and value details (daily detail limit).`);
    }
  }

  // ── Filter ─────────────────────────────────────────────────────────────
  /**
   * The viewport index changed: offer its fields (they're the same for every parcel), and
   * re-run a buffer preview, which counted only the parcels loaded when it ran (after a
   * search, the seed is often chosen before the index around it has loaded).
   */
  function indexChanged() {
    if (!state.fields.length) state.fields = filterFields(map.parcels());
    if (seedGeom) schedulePreview();
  }

  const filterMatches = () => matchParcels(map.parcels(), f);

  // The count follows the form; after Add or Remove it says what happened instead.
  watch(() => [f.field, f.op, f.value], () => {
    f.note = f.field && f.value.trim() ? `${plural(filterMatches().length, 'parcel')} match` : '';
  });

  function addFilterMatches() {
    f.note = `Added ${plural(map.add(filterMatches()), 'parcel')}`;
  }

  // Matched against the selection itself, not the viewport index: Add shows the first new
  // parcel, which pans the map when it's off screen and reloads the index around it, so
  // the index's matches were no longer the ones Add selected (DIC-2553).
  function removeFilterMatches() {
    const selected = map.selectedRecords().map((properties) => ({ properties }));
    const removed = map.remove(matchParcels(selected, f).map(pinOf));
    f.note = removed > 0 ? `Removed ${plural(removed, 'parcel')}` : 'None in selection';
  }

  // ── Buffer ─────────────────────────────────────────────────────────────
  function bufferPolygon() {
    const dist = parseFloat(b.distance);
    if (!seedGeom || !dist || dist <= 0 || !turf) return null;
    try {
      return turf.buffer({ type: 'Feature', geometry: seedGeom }, dist, { units: b.units });
    } catch (e) {
      console.warn('turf.buffer:', e);
      return null;
    }
  }

  function parcelsIn(polygon) {
    return map.parcels().filter((p) => {
      try { return turf.booleanIntersects(p, polygon); } catch { return false; }
    });
  }

  /** The parcels the buffer would add or remove (the seed only if "Include seed"). */
  function bufferMatches() {
    const polygon = bufferPolygon();
    if (!polygon) return null;
    const inside = parcelsIn(polygon);
    return b.includeSeed ? inside : inside.filter((p) => pinOf(p) !== b.seedPin);
  }

  function seedBuffer(feature) {
    b.seedPin = pinOf(feature);
    seedGeom = feature.geometry;
    map.setBufferSeed(b.seedPin);
    schedulePreview();
  }

  function clearPreview() {
    map.setBufferPreview(null, []);
    b.note = '';
  }

  function clearBuffer() {
    timers.clearTimeout(previewTimer);
    map.setBufferSeed(null);
    b.seedPin = null;
    seedGeom = null;
    clearPreview();
  }

  function schedulePreview() {
    timers.clearTimeout(previewTimer);
    previewTimer = timers.setTimeout(updatePreview, 300);
  }

  function updatePreview() {
    if (!seedGeom) return;
    if (!b.live) { clearPreview(); return; }
    const polygon = bufferPolygon();
    if (!polygon) { clearPreview(); return; }
    // The seed has its own highlight, so it's left out of the preview set.
    const pins = parcelsIn(polygon).map(pinOf).filter((pin) => pin !== b.seedPin);
    map.setBufferPreview(polygon, pins);
    const total = pins.length + (b.includeSeed && b.seedPin ? 1 : 0);
    b.note = `${plural(total, 'parcel')} in buffer`;
  }

  watch(() => [b.distance, b.units, b.includeSeed], schedulePreview);
  watch(() => b.live, (on) => (on ? schedulePreview() : clearPreview()));

  function addBufferMatches() {
    const matches = bufferMatches();
    if (!matches) return;
    map.add(matches);
    setTool(null);
  }

  function removeBufferMatches() {
    const matches = bufferMatches();
    if (!matches) return;
    map.remove(matches.map(pinOf));
    setTool(null);
  }

  return {
    state, setTool, escape, selectionChanged, clearSelection, downloadCsv,
    indexChanged, addFilterMatches, removeFilterMatches,
    seedBuffer, addBufferMatches, removeBufferMatches, updatePreview,
  };
}
