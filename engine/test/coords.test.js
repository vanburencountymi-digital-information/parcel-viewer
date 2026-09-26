'use strict';
// Coordinate formatters (DIC-1882): frontend/public/js/pv-coords.js is the one set used by
// the cursor readout, the parcel card's Center row and the right-click "Copy coordinates"
// menu. Pure module, loaded here in a sandbox with an optional proj4 stub.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'public', 'js', 'pv-coords.js'), 'utf8');

function load(proj4) {
  const sandbox = { proj4 };
  vm.createContext(sandbox);
  vm.runInContext(SRC.replace('typeof window !== \'undefined\' ? window : globalThis', 'globalThis'), sandbox);
  return sandbox.PV_COORD_FMT;
}

// Arrays made inside the vm sandbox belong to another realm; compare them as plain data.
const plain = (x) => JSON.parse(JSON.stringify(x));

const HERE = { lng: -86.09876, lat: 42.21234 };

// The readout code as it was in map.js before the move, to prove the move changed nothing.
function legacyReadout(ll, f, proj4) {
  const dd = (v, p, n) => Math.abs(v).toFixed(5) + '°' + (v >= 0 ? p : n);
  const dms = (v, p, n) => {
    let a = Math.abs(v), d = Math.floor(a), mf = (a - d) * 60, m = Math.floor(mf), s = Math.round((mf - m) * 60);
    if (s === 60) { s = 0; m++; }
    if (m === 60) { m = 0; d++; }
    const pad = (x) => (x < 10 ? '0' + x : '' + x);
    return d + '°' + pad(m) + "'" + pad(s) + '"' + (v >= 0 ? p : n);
  };
  if (f === 'dms') return dms(ll.lat, 'N', 'S') + '  ' + dms(ll.lng, 'E', 'W');
  if (f === 'spc' && proj4) {
    const xy = proj4('a', 'b', [ll.lng, ll.lat]);
    return 'N ' + Math.round(xy[1]).toLocaleString('en-US') + '  E ' + Math.round(xy[0]).toLocaleString('en-US') + ' ft';
  }
  return dd(ll.lat, 'N', 'S') + '  ' + dd(ll.lng, 'E', 'W');
}

const stubProj4 = (from, to, xy) => [13123359.58 + (xy[0] + 84.3666666667) * 272000, (xy[1] - 41.5) * 364000];

test('copy rows: every format, exactly as copied', () => {
  const rows = load(stubProj4).copyRows(HERE);
  const byId = Object.fromEntries(rows.map((r) => [r.id, r.text]));
  assert.deepStrictEqual(plain(rows.map((r) => r.id)), ['dd', 'dms', 'ddm', 'spc', 'lnglat']);
  assert.strictEqual(byId.dd, '42.212340, -86.098760');
  assert.strictEqual(byId.dms, '42°12\'44.4"N 86°05\'55.5"W');
  assert.strictEqual(byId.ddm, '42°12.740\'N 86°05.926\'W');
  assert.match(byId.spc, /^N \d+, E \d+$/);
  assert.strictEqual(byId.lnglat, '-86.098760, 42.212340');
  for (const r of rows) assert.ok(r.label && r.label.length > 3, r.id + ' has a label');
});

test('copy rows: no State Plane row without proj4', () => {
  assert.deepStrictEqual(plain(load(undefined).copyRows(HERE).map((r) => r.id)), ['dd', 'dms', 'ddm', 'lnglat']);
});

test('copy rows: a proj4 failure drops only the State Plane row', () => {
  const rows = load(() => { throw new Error('bad'); }).copyRows(HERE);
  assert.ok(!rows.some((r) => r.id === 'spc'));
  assert.strictEqual(rows.length, 4);
});

test('rounding carries: never 60 seconds or 60 minutes', () => {
  const f = load(undefined);
  const rows = f.copyRows({ lng: -86.9999999, lat: 42.9999999 });
  const byId = Object.fromEntries(rows.map((r) => [r.id, r.text]));
  assert.strictEqual(byId.dms, '43°00\'00.0"N 87°00\'00.0"W');
  assert.strictEqual(byId.ddm, '43°00.000\'N 87°00.000\'W');
  // 59.96" rounds to 60.0" → carries into the minute.
  const s = f.copyRows({ lng: 10, lat: 42 + 12 / 60 + 59.96 / 3600 })[1].text;
  assert.ok(s.startsWith('42°13\'00.0"N'), s);
});

test('southern and western hemispheres, and zero', () => {
  const byId = Object.fromEntries(load(undefined).copyRows({ lng: 151.2093, lat: -33.8688 }).map((r) => [r.id, r.text]));
  assert.strictEqual(byId.dms, '33°52\'07.7"S 151°12\'33.5"E');
  assert.strictEqual(byId.dd, '-33.868800, 151.209300');
  const zero = load(undefined).copyRows({ lng: 0, lat: 0 });
  assert.strictEqual(zero[1].text, '0°00\'00.0"N 0°00\'00.0"E');
});

test('invalid input gives no rows', () => {
  const f = load(undefined);
  assert.deepStrictEqual(plain(f.copyRows({ lng: NaN, lat: 1 })), []);
  assert.deepStrictEqual(plain(f.copyRows({ lng: 1, lat: Infinity })), []);
});

test('readout is unchanged from the pre-DIC-1882 map.js code', () => {
  const f = load(stubProj4);
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  for (let i = 0; i < 5000; i++) {
    const ll = { lng: -87 + rnd() * 2, lat: 41.5 + rnd() * 1.5 };
    for (const fmt of ['dd', 'dms', 'spc']) {
      assert.strictEqual(f.readout(ll, fmt), legacyReadout(ll, fmt, stubProj4), fmt + ' at ' + JSON.stringify(ll));
    }
  }
  assert.deepStrictEqual(plain(f.readoutFormats), ['dd', 'dms', 'spc']);
});

test('readout falls back to decimal degrees when State Plane is unavailable', () => {
  assert.strictEqual(load(undefined).readout(HERE, 'spc'), load(undefined).readout(HERE, 'dd'));
});
