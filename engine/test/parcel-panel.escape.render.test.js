'use strict';
// Render-path test for DIC-1852: tax-roll values (owner names, addresses, municipality…)
// are untrusted and must be HTML-escaped when the parcel info panel and the search
// results are written via innerHTML. Loads the REAL frontend/public/js/map.js against a
// permissive DOM stub, drives the panel through the PS_BUS 'active-feature-changed' event
// and the search box through its input listener, then inspects the resulting markup.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const REPO = path.resolve(__dirname, '..', '..');
const EVIL = '<img src=x onerror=alert(1)>';
const EVIL_ESC = '&lt;img src=x onerror=alert(1)&gt;';

// A "do anything" stub: every property read yields another stub (callable), writes are
// remembered. Enough for map.js's module init to run without a browser or MapLibre.
function stub(name, extra) {
  const store = Object.assign({}, extra);
  const listeners = {};
  store.addEventListener = (t, fn) => { (listeners[t] = listeners[t] || []).push(fn); };
  store._fire = (t, e) => (listeners[t] || []).forEach((fn) => fn(e || {}));
  const fn = function () { return stub(name + '()'); };
  return new Proxy(fn, {
    get(_t, k) {
      if (k in store) return store[k];
      if (k === Symbol.toPrimitive) return () => '';
      if (k === 'then') return undefined;               // not a thenable
      if (k === 'length') return 0;
      if (typeof k === 'symbol') return undefined;
      return (store[k] = stub(name + '.' + String(k)));
    },
    set(_t, k, v) { store[k] = v; return true; },
    has() { return true; },
  });
}

function load(searchResults) {
  const elements = {};
  const el = (id) => elements[id] || (elements[id] = stub('#' + id, { innerHTML: '', value: '', hidden: true }));
  const infoBody = stub('.parcel-info-body', { innerHTML: '' });
  el('parcel-info-panel').querySelector = () => infoBody;

  const created = [];
  const busHandlers = {};
  const sandbox = {
    console,
    Math, JSON, Date, Array, Object, String, Number, Boolean, RegExp, Error, Promise, Map, Set,
    parseInt, parseFloat, isNaN, isFinite, encodeURIComponent, decodeURIComponent,
    setTimeout: (fn) => { fn(); return 0; }, clearTimeout() {}, setInterval() { return 0; }, clearInterval() {},
    requestAnimationFrame() { return 0; },
    addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
    matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
    CustomEvent: function (t, o) { this.type = t; this.detail = o && o.detail; },
    navigator: { userAgent: 'node', clipboard: {} },
    location: { href: 'http://localhost/', search: '', hash: '', pathname: '/' },
    history: { replaceState() {}, pushState() {} },
    URLSearchParams,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    AbortController: function () { this.signal = {}; this.abort = () => {}; },
    fetch: (url) => Promise.resolve({
      ok: true,
      json: () => Promise.resolve(String(url).includes('/search') ? { results: searchResults || [] } : {}),
    }),
    PS_BUS: { on: (t, fn) => { busHandlers[t] = fn; }, emit() {} },
    maplibregl: stub('maplibregl'),
    turf: stub('turf'),
  };
  sandbox.window = sandbox; sandbox.self = sandbox;
  sandbox.document = stub('document', {
    getElementById: el,
    querySelector: () => stub('qs'),
    querySelectorAll: () => [],
    createElement: (tag) => { const e = stub('<' + tag + '>', { innerHTML: '' }); created.push(e); return e; },
    documentElement: stub('html', { getAttribute: () => null }),
  });
  vm.createContext(sandbox);
  const file = path.join(REPO, 'frontend/public/js/map.js');
  try { vm.runInContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: file }); }
  catch (e) { if (process.env.DEBUG_LOAD) console.error(e); /* late map-init code may trip on the stub; the handlers we need are wired earlier */ }
  return { busHandlers, infoBody, el, created };
}

const EVIL_PARCEL = {
  owner_name: 'SMITH & JONES ' + EVIL,
  owner_street: EVIL, owner_city: 'PAW PAW', owner_state: 'MI', owner_zip: '49079',
  prop_street: '123 MAIN ' + EVIL, prop_city: 'LAWTON',
  municipality: EVIL,
  prop_class: EVIL,
  school_dist: EVIL,
  legal_description: EVIL,
  source: EVIL,
};

test('parcel info panel escapes tax-roll values (fallback inline render)', () => {
  const { busHandlers, infoBody } = load();
  assert.ok(busHandlers['active-feature-changed'], 'map.js should subscribe to active-feature-changed');
  busHandlers['active-feature-changed']({ ref: { sourceId: 'parcels', pin: '80-01-001-001-00', properties: EVIL_PARCEL } });
  const html = infoBody.innerHTML;
  assert.ok(html.length > 0, 'panel should render');
  assert.doesNotMatch(html, /<img/i, 'no raw markup from parcel data');
  assert.ok(html.includes(EVIL_ESC), 'evil values render as escaped text');
  assert.ok(html.includes('SMITH &amp; JONES'), 'ampersands are escaped');
});

test('a hostile PIN in the selection key is escaped in the tool buttons (data-pin)', () => {
  const { busHandlers, infoBody } = load();
  busHandlers['active-feature-changed']({ ref: { sourceId: 'parcels', pin: '"><img src=x onerror=alert(1)>', properties: { owner_name: 'A' } } });
  const html = infoBody.innerHTML;
  assert.doesNotMatch(html, /<img/i, 'no markup escapes the data-pin attribute');
  assert.ok(html.includes('data-pin="&quot;&gt;&lt;img'), 'the PIN is attribute-escaped');
});

test('search results escape pin, municipality, owner and address', async () => {
  const { el, created } = load([{ id: 1, pin: EVIL, municipality: EVIL, owner_name: 'A & B ' + EVIL, address: EVIL }]);
  const input = el('parcel-search-input');
  input.value = 'smith';
  input._fire('input');
  await new Promise((r) => setImmediate(r));
  const rows = created.filter((e) => e.className === 'parcel-search-result');
  assert.equal(rows.length, 1, 'one result row rendered');
  const html = rows[0].innerHTML;
  assert.doesNotMatch(html, /<img/i, 'no raw markup from search data');
  assert.equal(html.split(EVIL_ESC).length - 1, 4, 'pin, municipality, owner, address all escaped');
  assert.ok(html.includes('A &amp; B'), 'ampersands are escaped');
});
