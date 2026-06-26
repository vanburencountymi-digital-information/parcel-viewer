'use strict';
// AI-mode controller (B1 / DIC-571) + availability auto-fallback (B4 / DIC-580).
// Verifies the deterministic logic of the real pv-ai-mode.js against a DOM stub: it
// reads PV_PREFS.getAiMode, reflects the EFFECTIVE state (wanted AND available) onto
// <html data-ai-mode> + the button, and degrades to facts without changing the
// preference when the service is unavailable. (The live Map Buddy CSS + the health
// poll are covered by on-map verification.)
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function el() {
  return {
    _a: {}, style: {}, className: '', textContent: '',
    classList: { _s: {}, add: function (c) { this._s[c] = 1; }, remove: function (c) { delete this._s[c]; }, toggle: function (c, on) { if (on) this._s[c] = 1; else delete this._s[c]; } },
    setAttribute: function (k, v) { this._a[k] = v; }, getAttribute: function (k) { return this._a[k]; },
    addEventListener: function () {}, appendChild: function () {},
  };
}

function load(initialMode) {
  var attrs = {};
  var btn = el();
  var sandbox = {};
  sandbox.window = sandbox;
  sandbox.console = console;
  sandbox.CustomEvent = function (t, o) { return { type: t, detail: o && o.detail }; };
  sandbox.addEventListener = function () {};
  sandbox.dispatchEvent = function () {};
  sandbox.document = {
    readyState: 'complete',
    documentElement: { setAttribute: function (k, v) { attrs[k] = v; }, getAttribute: function (k) { return attrs[k]; }, appendChild: function () {} },
    body: { appendChild: function () {} },
    head: { appendChild: function () {} },
    getElementById: function (id) { return id === 'pv-ai-toggle' ? btn : null; },
    createElement: function () { return el(); },
    addEventListener: function () {},
  };
  var store = { m: initialMode || 'off' };
  sandbox.PV_PREFS = {
    getAiMode: function () { return store.m; },
    setAiMode: function (m) { store.m = (m === 'on' ? 'on' : 'off'); return store.m; },
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', '..', 'frontend/public/js/pv-ai-mode.js'), 'utf8'), sandbox, { filename: 'pv-ai-mode.js' });
  return { sandbox, attrs: function () { return attrs; }, btn: btn };
}

test('default off: effective off, button unpressed', () => {
  const { sandbox, attrs, btn } = load('off');
  assert.equal(sandbox.PV_AI_MODE.isOn(), false);
  assert.equal(sandbox.PV_AI_MODE.isEffective(), false);
  assert.equal(attrs()['data-ai-mode'], 'off');
  assert.equal(btn.getAttribute('aria-pressed'), 'false');
});

test('on + available → effective on (data-ai-mode=on, button pressed)', () => {
  const { sandbox, attrs, btn } = load('on');
  assert.equal(sandbox.PV_AI_MODE.isEffective(), true);
  assert.equal(attrs()['data-ai-mode'], 'on');
  assert.equal(btn.getAttribute('aria-pressed'), 'true');
  assert.equal(btn.classList._s['is-on'], 1);
  assert.equal(btn.style.color, ''); // CSS owns icon contrast; no inline accent-on-accent.
});

test('B4 auto-fallback: on but UNAVAILABLE → degrade to facts WITHOUT changing the preference', () => {
  const { sandbox, attrs, btn } = load('on');
  sandbox.PV_AI_MODE.setAvailable(false);
  assert.equal(attrs()['data-ai-mode'], 'off');        // effective off
  assert.equal(sandbox.PV_AI_MODE.get(), 'on');        // preference unchanged
  assert.equal(sandbox.PV_AI_MODE.isEffective(), false);
  assert.equal(btn.getAttribute('aria-pressed'), 'true'); // button still shows user intent
  assert.equal(btn.classList._s['is-degraded'], 1);
  assert.equal(btn.style.color, '');
  // recovery re-enables automatically
  sandbox.PV_AI_MODE.setAvailable(true);
  assert.equal(attrs()['data-ai-mode'], 'on');
  assert.equal(sandbox.PV_AI_MODE.isEffective(), true);
});

test('set/toggle update PV_PREFS and isOn', () => {
  const { sandbox } = load('off');
  sandbox.PV_AI_MODE.set('on');
  assert.equal(sandbox.PV_AI_MODE.get(), 'on');
  sandbox.PV_AI_MODE.toggle();
  assert.equal(sandbox.PV_AI_MODE.get(), 'off');
});
