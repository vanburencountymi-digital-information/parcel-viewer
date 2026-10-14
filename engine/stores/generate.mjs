/**
 * generate.mjs — single-source generator for the shared ParcelStore contract (A6 / D1).
 *
 * parcel_contract.py here is the CANONICAL source of the canonical-parcel-record shape +
 * the ParcelStore interface, copied verbatim into each backend that implements a
 * ParcelStore. Today that's ZIP (psycopg2). The Parcel Viewer's FastAPI backend had one too;
 * it was retired with that backend (DIC-2150), and the Django API doesn't use the store.
 *
 * Running this writes parcel_contract.py to:
 *   - ZIP:            ../ZIP/zip-poc/backend/parcel_contract.py   (if the sibling repo is on disk)
 *
 * After editing the master, run `node engine/stores/generate.mjs`. The drift-guard
 * (engine/test/parcel-contract-sync.test.js) fails if a copy was edited directly.
 */
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const here = path.dirname(url.fileURLToPath(import.meta.url));   // engine/stores
const repo = path.resolve(here, '..', '..');                    // parcel-viewer/
const claude = path.resolve(repo, '..');                        // Desktop/Claude/

export const CONTRACT_FILE = 'parcel_contract.py';
export const ZIP_PATH = path.join(claude, 'ZIP', 'zip-poc', 'backend', CONTRACT_FILE);

export function masterSource() {
  return fs.readFileSync(path.join(here, CONTRACT_FILE), 'utf8');
}

function generate() {
  const master = masterSource();
  if (fs.existsSync(path.dirname(ZIP_PATH))) {
    fs.writeFileSync(ZIP_PATH, master);
    console.log('generated', path.relative(claude, ZIP_PATH));
  }
}

if (import.meta.url === url.pathToFileURL(process.argv[1]).href) generate();
