/**
 * generate.mjs — single-source generator for the shared drawing stack (A8 / DIC-575).
 *
 * The 5 files in this directory are the CANONICAL source for the drawing/annotation/
 * snapping/map-control stack that the Parcel Viewer (PS_ namespace) and ZIP (ZIP_
 * namespace) share. They were byte-identical except the namespace prefix and had begun
 * to drift; this makes them one source instead of two hand-maintained copies.
 *
 * Running this writes:
 *   - Parcel Viewer:  frontend/public/js/drawing/<f>.js   (verbatim — PS_ namespace)
 *   - ZIP:            ../ZIP/zip-poc/frontend/drawing/<f>.js  (PS_ -> ZIP_, word-boundary)
 *
 * The namespace transform is word-boundary-anchored so it only rewrites the namespace
 * tokens (PS_FOO / ps_foo) and never substrings like "maps_". Line endings (CRLF) are
 * preserved. After editing a master here, run `node engine/drawing/generate.mjs`.
 *
 * NOT YET CANONICAL HERE: measure-tool.js — it has a small (4-line) ZIP-specific
 * divergence (zip_bearing/zip_measure session keys); reconcile behind a capability flag
 * before bringing it under the generator. The eventual target (DIC-575) is to load ONE
 * copy at runtime, namespaced via the injected AppContext (A3) — this generator is the
 * safe drift-stopping first step toward that.
 */
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const here = path.dirname(url.fileURLToPath(import.meta.url));   // engine/drawing
const repo = path.resolve(here, '..', '..');                    // parcel-viewer/
const claude = path.resolve(repo, '..');                        // Desktop/Claude/

export const SHARED_FILES = ['annotation-store', 'undo-redo', 'snapping-engine', 'map-control-api', 'drawing-tools'];
const PV_DIR = path.join(repo, 'frontend', 'public', 'js', 'drawing');
const ZIP_DIR = path.join(claude, 'ZIP', 'zip-poc', 'frontend', 'drawing');

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
    fs.writeFileSync(path.join(PV_DIR, f + '.js'), master);                 // PV: verbatim
    if (fs.existsSync(ZIP_DIR)) fs.writeFileSync(path.join(ZIP_DIR, f + '.js'), toZipNamespace(master)); // ZIP: namespaced
    console.log('generated', f);
  }
}

if (import.meta.url === url.pathToFileURL(process.argv[1]).href) generate();
