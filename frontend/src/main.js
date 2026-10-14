// The viewer's Vue entry (DIC-2389, ADR 0017).
//
// Loaded as <script type="module"> at the end of demo/index.html, so it runs once the
// page is parsed and every classic script has run: the window hooks the islands read
// (src/shared/viewer.js) exist by then. Each island mounts on its own, so one that throws
// doesn't stop the others.
import { mountCompare } from './compare/index.js';
import { mountMapControls } from './map-controls/index.js';
import { mountParcelPanel } from './parcel-panel/index.js';
import { mountSelectTools } from './select-tools/index.js';

const ISLANDS = { compare: mountCompare, 'select-tools': mountSelectTools, 'parcel-panel': mountParcelPanel, 'map-controls': mountMapControls };

for (const [name, mount] of Object.entries(ISLANDS)) {
  try {
    mount();
  } catch (err) {
    // As a throwing classic script would: the error reaches pv-error-beacon.js.
    globalThis.reportError(new Error(`Vue island "${name}" failed to mount`, { cause: err }));
  }
}
