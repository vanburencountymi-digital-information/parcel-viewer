/**
 * pv-endpoints.js — the ONE place that resolves service base URLs (DIC-1856).
 *
 * The Map Buddy service URL lives in county config only (COUNTY.endpoints.mapBuddy in
 * county-config.js / the served /api/config.js / the theme manifest). Every module that
 * talks to Map Buddy (chat mount, explainer, citations, profile narration, AI health
 * check, admin console) resolves it here, so they all hit the same service with the same
 * precedence:
 *
 *   1. window.MAP_BUDDY_API        explicit override (e.g. '/map-buddy-api' to test the
 *                                  local container) — wins everywhere
 *   2. county config endpoints.mapBuddy
 *   3. '/map-buddy-api'            same-origin proxy. With no config this fails cleanly
 *                                  (the AI health check marks AI unavailable) instead of
 *                                  silently calling a URL baked into the code.
 *
 * Load after county-config.js and before any module that calls Map Buddy.
 */
(function (root) {
  'use strict';

  function countyConfig() {
    return (root.PS_CONTEXT && root.PS_CONTEXT.config) || root.COUNTY || {};
  }

  function mapBuddyBase() {
    var endpoints = countyConfig().endpoints || {};
    var base = root.MAP_BUDDY_API || endpoints.mapBuddy || '/map-buddy-api';
    return String(base).replace(/\/+$/, '');
  }

  root.PV_ENDPOINTS = { mapBuddyBase: mapBuddyBase };
})(typeof window !== 'undefined' ? window : globalThis);
