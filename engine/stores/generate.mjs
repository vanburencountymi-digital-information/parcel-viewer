/**
 * generate.mjs — single-source generator for the shared ParcelStore contract (A6 / D1).
 *
 * parcel_contract.py here is the CANONICAL source of the canonical-parcel-record shape +
 * the ParcelStore interface. The Parcel Viewer backend (psycopg3) and the ZIP backend
 * (psycopg2) each have their own ParcelStore impl but must produce the SAME record, so
 * the contract is defined once and copied — verbatim, since Python is identical in both
 * (no namespace prefix, unlike the JS drawing stack in engine/drawing/).
 *
 * Running this writes parcel_contract.py to:
 *   - Parcel Viewer:  backend/parcel_viewer/stores/parcel_contract.py
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
export const PV_PATH = path.join(repo, 'backend', 'parcel_viewer', 'stores', CONTRACT_FILE);
export const ZIP_PATH = path.join(claude, 'ZIP', 'zip-poc', 'backend', CONTRACT_FILE);

export function masterSource() {
  return fs.readFileSync(path.join(here, CONTRACT_FILE), 'utf8');
}

function generate() {
  const master = masterSource();
  fs.writeFileSync(PV_PATH, master);
  console.log('generated', path.relative(claude, PV_PATH));
  if (fs.existsSync(path.dirname(ZIP_PATH))) {
    fs.writeFileSync(ZIP_PATH, master);
    console.log('generated', path.relative(claude, ZIP_PATH));
  }
}

if (import.meta.url === url.pathToFileURL(process.argv[1]).href) generate();
