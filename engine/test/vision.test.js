'use strict';
// Map vision capture (DIC-2135): frontend/public/js/pv-vision.js sizes the screenshot for
// the vision model (at most 2,576 px on the long edge) and waits for the map to settle.
// Loaded in a sandbox with a fake map and canvas.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'public', 'js', 'pv-vision.js'), 'utf8');

function load(extra) {
  const sandbox = Object.assign({ setTimeout, Promise, Math, Error }, extra);
  vm.createContext(sandbox);
  vm.runInContext(SRC.replace('typeof window !== \'undefined\' ? window : globalThis', 'globalThis'), sandbox);
  return sandbox.PV_VISION;
}

const plain = (x) => JSON.parse(JSON.stringify(x));

test('fitSize keeps small views as they are and scales big ones to 2,576 px on the long edge', () => {
  const { fitSize, MAX_LONG_EDGE } = load();
  assert.strictEqual(MAX_LONG_EDGE, 2576);
  assert.deepStrictEqual(plain(fitSize(1600, 900, 2576)), { width: 1600, height: 900 });
  assert.deepStrictEqual(plain(fitSize(3840, 2160, 2576)), { width: 2576, height: 1449 });
  assert.deepStrictEqual(plain(fitSize(1200, 5152, 2576)), { width: 600, height: 2576 });
  assert.deepStrictEqual(plain(fitSize(0, 0, 2576)), { width: 0, height: 0 });
});

function fakeDom(drawn, dataUrls) {
  return {
    document: {
      createElement: () => ({
        width: 0,
        height: 0,
        getContext: () => ({ fillRect() {}, drawImage: (_src, _x, _y, w, h) => drawn.push([w, h]) }),
        toDataURL: (type, q) => { drawn.push([type, q]); return dataUrls.shift(); },
      }),
    },
  };
}

function fakeMap({ settled, canvas, pitch = 0, bearing = 0 }) {
  const handlers = {};
  const m = {
    pitch, bearing, jumps: [], stops: 0,
    loaded: () => settled, areTilesLoaded: () => settled, isMoving: () => !settled,
    once: (ev, fn) => { handlers[ev] = fn; },
    getCanvas: () => canvas,
    getPitch: () => m.pitch, getBearing: () => m.bearing,
    jumpTo: (o) => { m.jumps.push(o); m.pitch = o.pitch; m.bearing = o.bearing; },
    stop: () => { m.stops++; },
    // ~0.01° of longitude at 42.2° N ≈ 2,697 ft
    getBounds: () => ({ getWest: () => -86.01, getEast: () => -86.0, getNorth: () => 42.21, getSouth: () => 42.19 }),
    fire: (ev) => handlers[ev] && handlers[ev](),
  };
  return m;
}

test('capture scales the canvas, sends JPEG, and drops the data-URI prefix', async () => {
  const drawn = [];
  const V = load(fakeDom(drawn, ['data:image/jpeg;base64,QUJD']));
  const img = await V.capture(fakeMap({ settled: true, canvas: { width: 3840, height: 2160 } }));
  assert.deepStrictEqual(plain(img), { data: 'QUJD', media_type: 'image/jpeg', width: 2576, height: 1449, view_width_ft: 2697 });
  assert.deepStrictEqual(plain(drawn), [[2576, 1449], ['image/jpeg', 0.85]]);
});

test('capture lowers the JPEG quality until the image fits the 2 MB limit', async () => {
  const drawn = [];
  const big = 'data:image/jpeg;base64,' + 'A'.repeat(2800000);   // ~2.1 MB decoded
  const V = load(fakeDom(drawn, [big, 'data:image/jpeg;base64,QUJD']));
  const img = await V.capture(fakeMap({ settled: true, canvas: { width: 800, height: 600 } }));
  assert.strictEqual(img.data, 'QUJD');
  assert.deepStrictEqual(plain(drawn.slice(1)), [['image/jpeg', 0.85], ['image/jpeg', 0.7]]);
});

test('capture waits for the map to go idle before copying the canvas', async () => {
  const drawn = [];
  const V = load(fakeDom(drawn, ['data:image/jpeg;base64,QUJD']));
  const map = fakeMap({ settled: false, canvas: { width: 100, height: 100 } });
  const pending = V.capture(map);
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(drawn.length, 0, 'nothing captured while tiles are loading');
  map.fire('idle');
  const img = await pending;
  assert.strictEqual(img.width, 100);
});

test('a tilted or rotated view is stopped and turned straight down, north up, before capture', async () => {
  // The first live look was taken mid-orbit: tilted, so ballfields read as "tan basins".
  const drawn = [];
  let cancelled = 0;
  const V = load(Object.assign(fakeDom(drawn, ['data:image/jpeg;base64,QUJD']), {
    PS_cancelCinematic: () => { cancelled++; },
  }));
  const map = fakeMap({ settled: true, canvas: { width: 100, height: 100 }, pitch: 55, bearing: 140 });
  const pending = V.capture(map);
  assert.strictEqual(cancelled, 1, 'the fly-around is cancelled');
  assert.strictEqual(map.stops, 1, 'any easing is stopped');
  assert.deepStrictEqual(plain(map.jumps), [{ pitch: 0, bearing: 0 }]);
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(drawn.length, 0, 'after moving, it waits for the new view to draw');
  map.fire('idle');
  await pending;
  assert.strictEqual(drawn.length, 2);
});

test('a flat, north-up, settled view is captured as it is', async () => {
  const drawn = [];
  const V = load(fakeDom(drawn, ['data:image/jpeg;base64,QUJD']));
  const map = fakeMap({ settled: true, canvas: { width: 100, height: 100 } });
  await V.capture(map);
  assert.deepStrictEqual(plain(map.jumps), []);
});

test('viewWidthFt is the east-west span at the view center, or null when unknown', () => {
  const V = load();
  assert.strictEqual(V.viewWidthFt(fakeMap({ settled: true, canvas: {} })), 2697);
  assert.strictEqual(V.viewWidthFt({ getBounds: () => { throw new Error('no style'); } }), null);
});

test('capture refuses when there is no map', async () => {
  const V = load();
  await assert.rejects(V.capture(null), /isn’t ready/);
});
