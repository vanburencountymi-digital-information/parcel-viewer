/**
 * generate.mjs — single-source generator for the shared drawing stack (A8 / DIC-575).
 *
 * All 7 shared files in this directory are the CANONICAL source for the drawing/annotation/
 * snapping/map-control/measure/legend stack that the Parcel Viewer (PS_ namespace) and ZIP
 * (ZIP_ namespace) share. They were byte-identical except the namespace prefix and had begun
 * to drift; this makes them one source instead of two hand-maintained copies.
 *
 * Running this writes each file to its per-repo target (see TARGETS — most live in drawing/,
 * legend-panel one level up):
 *   - Parcel Viewer:  verbatim — PS_ namespace
 *   - ZIP:            PS_ -> ZIP_, word-boundary
 *
 * The namespace transform is word-boundary-anchored so it only rewrites the namespace
 * tokens (PS_FOO / ps_foo, incl. ps_bearing/ps_measure session keys) and never substrings
 * like "maps_". Line endings (CRLF) are preserved. After editing a master here, run
 * `node engine/drawing/generate.mjs`.
 *
 * measure-tool.js IS now canonical (the master = PV's superset). Its only non-namespace
 * delta from ZIP's old copy was PV's extra `dimensionParcel` public method (exposes the
 * shared runAutoDim for Map Buddy) — additive/inert, so generating gives ZIP that method
 * harmlessly (no capability flag needed; it changes no existing ZIP behavior).
 *
 * legend-panel.js (7th shared file) lives outside the drawing/ dir in both repos; it joins
 * via the TARGETS per-file path map (it was already byte-identical mod namespace). The
 * eventual target (DIC-575) is to load ONE copy at RUNTIME, namespaced via the injected
 * AppContext (A3) — this generator is the safe drift-stopping first step toward that.
 */
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const here = path.dirname(url.fileURLToPath(import.meta.url));   // engine/drawing
const repo = path.resolve(here, '..', '..');                    // parcel-viewer/
const claude = path.resolve(repo, '..');                        // Desktop/Claude/

export const SHARED_FILES = ['annotation-store', 'undo-redo', 'snapping-engine', 'map-control-api', 'drawing-tools', 'measure-tool', 'legend-panel'];
const PV_DIR = path.join(repo, 'frontend', 'public', 'js', 'drawing');
const ZIP_DIR = path.join(claude, 'ZIP', 'zip-poc', 'frontend', 'drawing');

// Per-file target paths. Most shared files live in each repo's drawing/ subdir; a few
// (legend-panel) sit one level up. The master always lives here in engine/drawing/.
const TARGETS = {
  'legend-panel': {
    pv:  path.join(repo, 'frontend', 'public', 'js', 'legend-panel.js'),
    zip: path.join(claude, 'ZIP', 'zip-poc', 'frontend', 'legend-panel.js'),
  },
};
export function pvTarget(f)  { return (TARGETS[f] && TARGETS[f].pv)  || path.join(PV_DIR, f + '.js'); }
export function zipTarget(f) { return (TARGETS[f] && TARGETS[f].zip) || path.join(ZIP_DIR, f + '.js'); }

// PS_ -> ZIP_ for the viewer's namespace, word-boundary anchored so "maps_" etc. are
// never touched. Covers the uppercase token and the few lowercase ones (ps_bearing…).
export function toZipNamespace(src) {
  return src.replace(/\bPS_/g, 'ZIP_').replace(/\bps_/g, 'zip_');
}

export function masterSource(f) {
  return fs.readFileSync(path.join(here, f + '.js'), 'utf8');
}

function generate() {
  for (const f of SHARED_FILES) {
    const master = masterSource(f);
    fs.writeFileSync(pvTarget(f), master);                 // PV: verbatim
    const zipPath = zipTarget(f);
    if (fs.existsSync(path.dirname(zipPath))) fs.writeFileSync(zipPath, toZipNamespace(master)); // ZIP: namespaced
    console.log('generated', f);
  }
}

if (import.meta.url === url.pathToFileURL(process.argv[1]).href) generate();
