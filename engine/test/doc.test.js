'use strict';
// Source-agnostic document utils (A7b / DIC-573). The map handle is injected; no
// global reads; print/downloadHtml carry no domain knowledge.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const DOC = require('../doc.js');

test('captureCanvasImage takes an injected map handle (getCanvas)', () => {
  const fakeMap = { getCanvas: () => ({ toDataURL: () => 'data:image/png;base64,MAP' }) };
  assert.equal(DOC.captureCanvasImage(fakeMap), 'data:image/png;base64,MAP');
});

test('captureCanvasImage also accepts a raw canvas (toDataURL)', () => {
  const fakeCanvas = { toDataURL: () => 'data:image/png;base64,CANVAS' };
  assert.equal(DOC.captureCanvasImage(fakeCanvas), 'data:image/png;base64,CANVAS');
});

test('captureCanvasImage returns null for missing/unsupported handles (never throws)', () => {
  assert.equal(DOC.captureCanvasImage(null), null);
  assert.equal(DOC.captureCanvasImage({}), null);
  assert.equal(DOC.captureCanvasImage({ getCanvas: () => { throw new Error('tainted'); } }), null);
});

test('print/downloadHtml are functions and no-op safely without a DOM', () => {
  assert.equal(typeof DOC.print, 'function');
  assert.equal(typeof DOC.downloadHtml, 'function');
  assert.doesNotThrow(() => DOC.print('<p>x</p>'));            // no document in Node → no-op
  assert.doesNotThrow(() => DOC.downloadHtml('<p>x</p>', 'f'));
});

test('the doc engine carries no domain noun and reads no global (§4.1, §6.1)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'doc.js'), 'utf8');
  assert.ok(!/\bparcel/i.test(src), 'doc.js must be source-agnostic');
  assert.ok(!/PS_MAP|root\.PS_|window\.PS_/.test(src), 'doc.js must not read a global map handle');
});
