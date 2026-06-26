/**
 * app-context.js — injected AppContext + event bus (A3 / DIC-568).
 *
 * The replacement for global-singleton discovery: instead of every module reaching
 * into ambient globals, it receives an AppContext and reads `ctx.map`, `ctx.config`,
 * `ctx.state`, `ctx.sourceIndex`, `ctx.bus`, `ctx.stores`. This module is the
 * source-agnostic core of that seam — it holds NO global names and NO domain
 * vocabulary (§4.1, §6.1). The viewer-specific bridge that points these slots at the
 * live globals lives in the frontend, so the strangler-fig migration can proceed
 * file-by-file with no behavior change.
 *
 * Strangler-fig (the #1-risk migration): the bridge exposes the SAME underlying
 * objects the globals point at, so old code and downstream consumers keep working
 * while new code moves to `ctx.map`. See engine/MIGRATION.md.
 *
 * UMD: Node module (harness) + browser global (window.ISV_CONTEXT).
 */
(function (root, factory) {
  'use strict';
  var mod = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
  root.ISV_CONTEXT = mod;
}(typeof self !== 'undefined' ? self : this, function (root) {
  'use strict';

  // ── Event bus ───────────────────────────────────────────────────────────────
  // Tiny synchronous pub/sub. A4 emits 'selection-changed' / 'active-feature-changed'
  // here; rendering + panels subscribe instead of polling a global state machine.
  function createEventBus() {
    var listeners = Object.create(null);

    function on(type, fn) {
      (listeners[type] || (listeners[type] = [])).push(fn);
      return function off() { remove(type, fn); };
    }
    function remove(type, fn) {
      var a = listeners[type]; if (!a) return;
      var i = a.indexOf(fn); if (i >= 0) a.splice(i, 1);
    }
    function once(type, fn) {
      var off = on(type, function (detail) { off(); fn(detail); });
      return off;
    }
    function emit(type, detail) {
      var a = listeners[type]; if (!a) return;
      a.slice().forEach(function (fn) {
        try { fn(detail); } catch (e) { if (root.console) root.console.error(e); }
      });
    }
    function clear() { listeners = Object.create(null); }

    return { on: on, off: remove, once: once, emit: emit, clear: clear };
  }

  // ── AppContext ──────────────────────────────────────────────────────────────
  // A plain view object. Every slot comes from `opts` — typically live getters the
  // viewer bridge supplies (so `ctx.map` tracks the current map), or fixed values a
  // test/plugin injects. The engine never names a global here.
  //
  // opts = { map?, config?, state?, prefs?, sourceIndex?, stores?, bus? }  (all optional)
  function createAppContext(opts) {
    opts = opts || {};
    var bus = opts.bus || createEventBus();
    var stores = opts.stores || {};
    var ctx = { bus: bus, stores: stores };
    // Defined as getters so a live getter passed in `opts` stays live.
    ['map', 'config', 'state', 'prefs', 'sourceIndex'].forEach(function (slot) {
      Object.defineProperty(ctx, slot, { enumerable: true, get: function () { return opts[slot]; } });
    });
    return ctx;
  }

  return { createEventBus: createEventBus, createAppContext: createAppContext };
}));
