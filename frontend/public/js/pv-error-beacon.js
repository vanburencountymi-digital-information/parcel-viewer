/**
 * pv-error-beacon.js — report JavaScript errors to the server (DIC-1879, ADR 0001).
 *
 * Breakage that only happens in a tester's browser is otherwise invisible to us. This
 * sends uncaught errors and unhandled promise rejections to POST /api/client-errors,
 * where each becomes one warning log line (nothing is stored).
 *
 * Load it first, so errors during startup are caught too. Limits:
 *   - at most MAX_REPORTS per page load, and never the same error twice;
 *   - only errors from this site's own scripts (browser extensions and third-party
 *     scripts are ignored: we can't fix them, and their messages can carry data);
 *   - only the page path is sent, never the query string.
 */
(function (root) {
  'use strict';

  var MAX_REPORTS = 5;
  var ENDPOINT = '/api/client-errors';
  var sent = 0;
  var seen = {};

  function clip(value, max) {
    return value == null ? null : String(value).slice(0, max);
  }

  function ownScript(source) {
    // No source: the error came from inline code or the browser; keep it.
    return !source || String(source).indexOf(root.location.origin) === 0;
  }

  function report(kind, message, source, line, column) {
    if (sent >= MAX_REPORTS || !ownScript(source)) return;
    var key = kind + '|' + message + '|' + source + '|' + line;
    if (seen[key]) return;
    seen[key] = true;
    sent++;
    var body = JSON.stringify({
      kind: kind,
      message: clip(message || 'unknown error', 500),
      source: clip(source ? String(source).split('?')[0] : null, 300),
      line: typeof line === 'number' ? line : null,
      column: typeof column === 'number' ? column : null,
      page: clip(root.location.pathname, 300),
    });
    try {
      var blob = new Blob([body], { type: 'application/json' });
      if (root.navigator.sendBeacon && root.navigator.sendBeacon(ENDPOINT, blob)) return;
    } catch (_) { /* fall back to fetch */ }
    try {
      root.fetch(ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body, keepalive: true })
        .catch(function () { /* reporting must never cause another error */ });
    } catch (_) { /* ditto */ }
  }

  root.addEventListener('error', function (e) {
    // Resource load failures (img/script 404s) also fire 'error' but carry no message.
    if (!e || !e.message) return;
    report('error', e.message, e.filename, e.lineno, e.colno);
  });

  root.addEventListener('unhandledrejection', function (e) {
    var reason = e && e.reason;
    var message = reason && reason.message ? reason.message : String(reason);
    var stackTop = reason && reason.stack ? String(reason.stack).split('\n')[1] : '';
    var match = /\((https?:\/\/[^)]+?):(\d+):(\d+)\)|at (https?:\/\/\S+?):(\d+):(\d+)/.exec(stackTop || '');
    var source = match ? (match[1] || match[4]) : null;
    var line = match ? Number(match[2] || match[5]) : null;
    var column = match ? Number(match[3] || match[6]) : null;
    report('unhandledrejection', message, source, line, column);
  });

  root.PV_ERROR_BEACON = { report: report };
})(window);
