/**
 * pv-ai-health.js — runtime AI-availability auto-fallback (B4 / DIC-580).
 *
 * Polls the Map Buddy service health and tells PV_AI_MODE whether AI is reachable.
 * If the user wants AI on but the service is down, PV_AI_MODE degrades to facts
 * (without changing the user's preference) and shows a calm notice; when the service
 * recovers, AI affordances re-enable automatically (§4.4b). The viewer's static
 * config-API fallback is a separate concern; this is the AI-availability one.
 *
 * Polls only WHILE the user wants AI on (no needless pings when AI is off), checks
 * immediately on toggle-on, and keeps polling while down so it notices recovery.
 *
 * Exposes: window.PV_AI_HEALTH { check, mapBuddyBase }
 */
(function (root) {
  'use strict';
  var doc = root.document;
  var POLL_MS = 30000;
  var TIMEOUT_MS = 4000;
  var FAIL_THRESHOLD = 2;   // tolerate ONE transient miss before degrading (cold start, brief blip)
  var RETRY_MS = 6000;      // after a sub-threshold miss, re-check soon (don't wait a full poll)
  var _timer = null;
  var _retryTimer = null;
  var _fails = 0;

  function countyConfig() {
    return (root.PS_CONTEXT && root.PS_CONTEXT.config) || root.COUNTY || {};
  }

  // Same resolution pv-explain uses, so we health-check the service the explainer/
  // Map Buddy actually call.
  function mapBuddyBase() {
    var isLocal = /^(localhost|127\.0\.0\.1)$/.test(root.location.hostname);
    var endpoints = countyConfig().endpoints || {};
    return endpoints.mapBuddy ||
      root.MAP_BUDDY_API ||
      (isLocal && '/map-buddy-api') ||
      'https://map-buddy-toaozre74a-uc.a.run.app';
  }

  function setAvail(a) {
    if (root.PV_AI_MODE && typeof root.PV_AI_MODE.setAvailable === 'function') root.PV_AI_MODE.setAvailable(a);
  }

  // Hysteresis (§4.4b): a SINGLE failed ping no longer declares AI down — the "AI is
  // unavailable" notice was popping prematurely while an explainer/Map Buddy call was still
  // assembling (a Cloud Run cold start makes the first /health ping time out even though the
  // request ultimately succeeds). We require FAIL_THRESHOLD consecutive misses before
  // degrading, recover instantly on any success, and re-check quickly after a sub-threshold
  // miss so a genuine outage is still caught within a few seconds.
  function onResult(ok) {
    if (ok) { _fails = 0; setAvail(true); return; }
    _fails += 1;
    if (_fails >= FAIL_THRESHOLD) { setAvail(false); return; }
    if (!_retryTimer) {
      _retryTimer = setTimeout(function () { _retryTimer = null; if (wantsAi()) check(); }, RETRY_MS);
    }
  }

  function check() {
    var ctrl = ('AbortController' in root) ? new root.AbortController() : null;
    var to = ctrl ? setTimeout(function () { try { ctrl.abort(); } catch (_) {} }, TIMEOUT_MS) : null;
    return root.fetch(mapBuddyBase() + '/health', { signal: ctrl ? ctrl.signal : undefined, cache: 'no-store' })
      .then(function (r) { onResult(!!r && r.ok); })
      .catch(function () { onResult(false); })
      .then(function () { if (to) clearTimeout(to); });
  }

  function wantsAi() { return !!(root.PV_AI_MODE && root.PV_AI_MODE.isOn && root.PV_AI_MODE.isOn()); }
  function tick() { if (wantsAi()) check(); }

  function start() {
    if (_timer) return;
    tick();
    _timer = setInterval(tick, POLL_MS);
  }

  // Check immediately when the user turns AI on (don't wait for the next poll).
  root.addEventListener('pv-ai-mode-change', tick);

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', start);
  else start();

  root.PV_AI_HEALTH = { check: check, mapBuddyBase: mapBuddyBase };
}(typeof window !== 'undefined' ? window : this));
