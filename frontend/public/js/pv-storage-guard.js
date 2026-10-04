/**
 * pv-storage-guard.js — load FIRST, before any other script (DIC-1873).
 *
 * With cookies/site data blocked (browser privacy settings, some in-app webviews), merely
 * touching `window.localStorage` throws a SecurityError. Dozens of call sites read and
 * write preferences through it without a try/catch, so the viewer's bootstrap threw and
 * the page stayed blank. If storage is unusable, this swaps in an in-memory stand-in with
 * the same API: preferences simply don't persist across reloads, and everything else works.
 */
(function (root) {
  'use strict';
  try {
    var s = root.localStorage;
    var k = '__pv_storage_probe__';
    s.setItem(k, '1');
    s.removeItem(k);
    return;                                   // real storage works: nothing to do
  } catch (_) { /* blocked or unavailable: fall through */ }

  var data = {};
  var memory = {
    getItem: function (key) { key = String(key); return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null; },
    setItem: function (key, val) { data[String(key)] = String(val); },
    removeItem: function (key) { delete data[String(key)]; },
    clear: function () { data = {}; },
    key: function (i) { return Object.keys(data)[i] || null; },
    get length() { return Object.keys(data).length; },
  };
  try {
    Object.defineProperty(root, 'localStorage', { configurable: true, get: function () { return memory; } });
    root.PV_STORAGE_FALLBACK = true;          // lets diagnostics/tests see the fallback is active
  } catch (_) { /* property not redefinable here; nothing more we can do */ }
})(typeof window !== 'undefined' ? window : globalThis);
