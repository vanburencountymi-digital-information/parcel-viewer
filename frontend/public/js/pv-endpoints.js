/**
 * pv-endpoints.js — the ONE place that resolves service base URLs (DIC-1856).
 *
 * The Map Buddy service URL lives in county config only (COUNTY.endpoints.mapBuddy in
 * county-config.js / the served /api/config.js / the theme manifest). Every module that
 * talks to Map Buddy (chat mount, explainer, citations, profile narration, AI health
 * check, admin console) resolves it here, so they all hit the same service with the same
 * precedence:
 *
 *   1. window.MAP_BUDDY_API        explicit override — wins everywhere
 *   2. '/map-buddy-api' on localhost / 127.0.0.1 (the dev stack's bundled container)
 *   3. county config endpoints.mapBuddy
 *   4. '/map-buddy-api'            same-origin proxy. With no config this fails cleanly
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

  // Local dev (the docker compose stack on localhost): use the bundled Map Buddy container
  // via the same-origin proxy, so you test the code in this checkout. The deployed Cloud
  // Run service is a different build and doesn't allow local origins.
  function isLocalHost() {
    var h = (root.location && root.location.hostname) || '';
    return h === 'localhost' || h === '127.0.0.1';
  }

  function mapBuddyBase() {
    var endpoints = countyConfig().endpoints || {};
    var base = root.MAP_BUDDY_API ||
      (isLocalHost() && '/map-buddy-api') ||
      endpoints.mapBuddy ||
      '/map-buddy-api';
    return String(base).replace(/\/+$/, '');
  }

  root.PV_ENDPOINTS = { mapBuddyBase: mapBuddyBase };
})(typeof window !== 'undefined' ? window : globalThis);
