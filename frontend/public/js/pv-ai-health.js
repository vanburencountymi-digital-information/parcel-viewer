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
  var _timer = null;

  // Same resolution pv-explain uses, so we health-check the service the explainer/
  // Map Buddy actually call.
  function mapBuddyBase() {
    var isLocal = /^(localhost|127\.0\.0\.1)$/.test(root.location.hostname);
    return (root.COUNTY && root.COUNTY.endpoints && root.COUNTY.endpoints.mapBuddy) ||
      root.MAP_BUDDY_API ||
      (isLocal && '/map-buddy-api') ||
      'https://map-buddy-toaozre74a-uc.a.run.app';
  }

  function setAvail(a) {
    if (root.PV_AI_MODE && typeof root.PV_AI_MODE.setAvailable === 'function') root.PV_AI_MODE.setAvailable(a);
  }

  function check() {
    var ctrl = ('AbortController' in root) ? new root.AbortController() : null;
    var to = ctrl ? setTimeout(function () { try { ctrl.abort(); } catch (_) {} }, TIMEOUT_MS) : null;
    return root.fetch(mapBuddyBase() + '/health', { signal: ctrl ? ctrl.signal : undefined, cache: 'no-store' })
      .then(function (r) { setAvail(!!r && r.ok); })
      .catch(function () { setAvail(false); })
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
