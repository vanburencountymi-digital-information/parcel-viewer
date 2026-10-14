// The Selection Tools pane as a Vue island (DIC-2389): mounts into #mcp-pane-select and
// connects the store to the map side (PS_SELECT_MAP, map.js) and the page's events.
import { createApp } from 'vue';
import * as viewer from '../shared/viewer.js';
import SelectTools from './SelectTools.vue';
import { createSelectToolsStore } from './store.js';

/** Saves `text` as a file named `filename` (a download link, clicked). */
function downloadText(text, filename, doc) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8;' }));
  const a = Object.assign(doc.createElement('a'), { href: url, download: filename });
  doc.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function mountSelectTools(doc = document) {
  const pane = doc.getElementById('mcp-pane-select');
  const map = viewer.selectMap();
  if (!pane || !map) return null;      // no pane on this page, or map.js didn't load

  const acc = viewer.access();
  const store = createSelectToolsStore({
    map,
    turf: viewer.turf(),
    isWithheld: (props) => !!(acc && acc.isWithheld(props)),
    download: (text, filename) => downloadText(text, filename, doc),
  });

  map.onBufferSeed = store.seedBuffer;
  doc.addEventListener('ps:selection-changed', (e) => store.selectionChanged(((e.detail || {}).pins || []).length));
  doc.addEventListener('ps:parcel-index-updated', store.indexChanged);
  doc.addEventListener('keydown', (e) => { if (e.key === 'Escape') store.escape(); });
  store.indexChanged();                // the index may have loaded before this mounted

  // Mounting replaces the pane's children; its own attributes (hidden, role) stay map.js's.
  createApp(SelectTools, { store }).mount(pane);
  return store;
}
