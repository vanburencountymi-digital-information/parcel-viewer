'use strict';
// AI-mode controller (B1 / DIC-571) — verifies the deterministic bits of the real
// pv-ai-mode.js against a minimal DOM stub: it reads PV_PREFS.getAiMode, and apply()
// reflects the mode onto <html data-ai-mode> and the toggle button. (The event-driven
// path + Map Buddy CSS are covered by live verification on the dockerized map.)
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function load(initialMode) {
  var attrs = {};
  var btn = { _a: {}, style: {}, classList: { toggle: function () {} }, addEventListener: function () {},
    setAttribute: function (k, v) { this._a[k] = v; }, getAttribute: function (k) { return this._a[k]; } };
  var sandbox = {};
  sandbox.window = sandbox;
  sandbox.console = console;
  sandbox.CustomEvent = function (t, o) { return { type: t, detail: o && o.detail }; };
  sandbox.addEventListener = function () {};
  sandbox.document = {
    readyState: 'complete',
    documentElement: { setAttribute: function (k, v) { attrs[k] = v; }, getAttribute: function (k) { return attrs[k]; } },
    head: { appendChild: function () {} },
    getElementById: function (id) { return id === 'pv-ai-toggle' ? btn : null; },
    createElement: function () { return { style: {}, setAttribute: function () {}, appendChild: function () {} }; },
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

test('default off: get() reads PV_PREFS, apply reflects onto <html> + button', () => {
  const { sandbox, attrs, btn } = load('off');
  assert.equal(sandbox.PV_AI_MODE.get(), 'off');
  assert.equal(sandbox.PV_AI_MODE.isOn(), false);
  assert.equal(attrs()['data-ai-mode'], 'off');      // applied on wire()
  assert.equal(btn.getAttribute('aria-pressed'), 'false');
});

test('apply("on") sets data-ai-mode=on and presses the button', () => {
  const { sandbox, attrs, btn } = load('off');
  sandbox.PV_AI_MODE.apply('on');
  assert.equal(attrs()['data-ai-mode'], 'on');
  assert.equal(btn.getAttribute('aria-pressed'), 'true');
});

test('set/toggle update PV_PREFS and isOn', () => {
  const { sandbox } = load('off');
  sandbox.PV_AI_MODE.set('on');
  assert.equal(sandbox.PV_AI_MODE.get(), 'on');
  sandbox.PV_AI_MODE.toggle();
  assert.equal(sandbox.PV_AI_MODE.get(), 'off');
});

test('starting on: get() reflects it', () => {
  const { sandbox, attrs } = load('on');
  assert.equal(sandbox.PV_AI_MODE.isOn(), true);
  assert.equal(attrs()['data-ai-mode'], 'on');
});
