/**
 * pv-dialog.js — keyboard behaviour for the viewer's overlay dialogs (DIC-1873).
 *
 * The admin-menu modal already handles Esc, focus and Tab; the Compare and Neighborhood
 * Profile overlays (aria-modal dialogs built in pv-compare.js / pv-profile.js) didn't, so
 * keyboard and screen-reader users could neither reach nor leave them. Call:
 *
 *   PV_DIALOG.opened(overlayEl, closeFn)  after showing the overlay
 *   PV_DIALOG.closed(overlayEl)           after hiding it
 *
 * While open: Esc calls closeFn, Tab / Shift+Tab stay inside, and on close focus returns
 * to whatever had it before. One dialog at a time (the last opened wins).
 */
(function (root) {
  'use strict';

  var active = null;   // { el, close, returnTo }

  function focusables(el) {
    return [].filter.call(
      el.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'),
      function (n) { return !n.disabled && n.offsetParent !== null; });
  }

  function release() {
    active = null;
    root.document.removeEventListener('keydown', onKey, true);
  }

  function onKey(e) {
    if (!active) return;
    if (active.el.hidden) { release(); return; }
    if (e.key === 'Escape') {
      // Capture phase + stop: the dialog owns Esc (the map would otherwise also clear
      // the parcel selection behind it).
      e.preventDefault();
      e.stopPropagation();
      active.close();
      return;
    }
    if (e.key !== 'Tab') return;
    var f = focusables(active.el);
    if (!f.length) { e.preventDefault(); return; }
    var first = f[0], last = f[f.length - 1], cur = root.document.activeElement;
    if (e.shiftKey && (cur === first || !active.el.contains(cur))) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && (cur === last || !active.el.contains(cur))) { e.preventDefault(); first.focus(); }
  }

  function opened(el, close) {
    if (!el) return;
    if (!active || active.el !== el) {
      active = { el: el, close: close, returnTo: root.document.activeElement };
    }
    root.document.addEventListener('keydown', onKey, true);
    var target = el.querySelector('[aria-label="Close"]') || focusables(el)[0];
    if (target) target.focus();
  }

  function closed(el) {
    if (!active || active.el !== el) return;
    var back = active.returnTo;
    release();
    if (back && back.focus && root.document.contains(back)) back.focus();
  }

  root.PV_DIALOG = { opened: opened, closed: closed };
})(typeof window !== 'undefined' ? window : globalThis);
