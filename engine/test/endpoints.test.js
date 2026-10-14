'use strict';
// Service-URL hygiene (DIC-1856). The Map Buddy URL must live in county config only and
// be resolved in one place (frontend/public/js/pv-endpoints.js). This fails if a code
// file hardcodes a Cloud Run URL again, or if the config copies drift apart — both of
// which made a Map Buddy redeploy a hunt through ~10 files.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadFile } = require('./helpers/sandbox.js');

const REPO = path.resolve(__dirname, '..', '..');

// Config files are the only places a service URL may appear.
const CONFIG_FILES = new Set([
  'frontend/public/js/county-config.js',
  // The API's baked copy, served as /api/config.js when the config store is empty or down.
  'api/county_config/baked/vanburen.json',
  'engine/themes/vanburen.json',
]);

function walk(dir, out) {
  for (const ent of fs.readdirSync(path.join(REPO, dir), { withFileTypes: true })) {
    const rel = path.posix.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === 'node_modules' || ent.name === 'fixtures' || ent.name.startsWith('.')) continue;
      walk(rel, out);
    } else if (/\.(js|html)$/.test(ent.name)) {
      out.push(rel);
    }
  }
  return out;
}

test('no code file hardcodes a Cloud Run service URL', () => {
  const files = ['frontend', 'admin', 'demo', 'map-buddy/js', 'engine']
    .flatMap((d) => walk(d, []))
    .filter((f) => !CONFIG_FILES.has(f) && !f.startsWith('engine/test/'));
  const offenders = files.filter((f) => /https:\/\/[\w.-]+\.run\.app/.test(fs.readFileSync(path.join(REPO, f), 'utf8')));
  assert.deepEqual(offenders, [], 'service URLs belong in county config; resolve them via PV_ENDPOINTS');
});

test('every config copy of the Map Buddy URL agrees', () => {
  const countyJs = fs.readFileSync(path.join(REPO, 'frontend/public/js/county-config.js'), 'utf8');
  const baked = (countyJs.match(/mapBuddy:\s*"([^"]+)"/) || [])[1];
  const served = require(path.join(REPO, 'api/county_config/baked/vanburen.json')).endpoints.mapBuddy;
  const theme = require(path.join(REPO, 'engine/themes/vanburen.json'));
  const copies = {
    'county-config.js endpoints.mapBuddy': baked,
    'api/county_config/baked/vanburen.json endpoints.mapBuddy': served,
    'themes/vanburen.json endpoints.mapBuddy': theme.endpoints && theme.endpoints.mapBuddy,
    'themes/vanburen.json mapBuddy.apiBase': theme.mapBuddy && theme.mapBuddy.apiBase,
  };
  assert.ok(baked, 'county-config.js has an endpoints.mapBuddy');
  for (const [where, url] of Object.entries(copies)) assert.equal(url, baked, `${where} differs`);
});

async function resolver(win) {
  const sandbox = Object.assign({}, win);
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  await loadFile(sandbox, 'frontend/public/js/pv-endpoints.js');
  return sandbox.PV_ENDPOINTS.mapBuddyBase;
}

test('PV_ENDPOINTS precedence: override > county config > same-origin proxy', async () => {
  const cfg = { endpoints: { mapBuddy: 'https://mb.example/' } };
  assert.equal((await resolver({ MAP_BUDDY_API: '/map-buddy-api', COUNTY: cfg }))(), '/map-buddy-api');
  assert.equal((await resolver({ COUNTY: cfg }))(), 'https://mb.example');          // trailing slash trimmed
  assert.equal((await resolver({ PS_CONTEXT: { config: cfg }, COUNTY: {} }))(), 'https://mb.example');
  assert.equal((await resolver({ COUNTY: {} }))(), '/map-buddy-api');              // never a baked-in URL
  // Local dev stack: the bundled container, unless explicitly overridden.
  const local = { location: { hostname: '127.0.0.1' }, COUNTY: cfg };
  assert.equal((await resolver(local))(), '/map-buddy-api');
  assert.equal((await resolver(Object.assign({ MAP_BUDDY_API: 'https://mb.test' }, local)))(), 'https://mb.test');
  assert.equal((await resolver({ location: { hostname: 'parcels.dicemi.org' }, COUNTY: cfg }))(), 'https://mb.example');
});
