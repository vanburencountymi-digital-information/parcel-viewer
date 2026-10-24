/**
 * pv-runtime-config.js — where the viewer's own services live (was an inline script in
 * demo/index.html; moved to a file so the CSP's script-src needs no 'unsafe-inline',
 * DIC-2556). Loads in <head>, before anything that reads window.PS_CONFIG / API_BASE.
 *
 * Every service is same-origin behind nginx: /api (Django), /tiles (Martin). WS_URL is
 * empty (no live-update socket). The old build-time knobs (%VITE_API_BASE% etc. in the
 * HTML) were never set by any build or deploy, so these are the values the viewer always
 * had; a deploy that needs others sets them here.
 *
 * PV_CONFIG_SOURCE starts as 'fallback' (the baked county-config.js); the served
 * /api/config.js sets it to 'api' when it loads. This replaces the onerror attribute that
 * used to mark the fallback, which a CSP without 'unsafe-inline' wouldn't run.
 */
(function (root) {
  'use strict';
  root.PS_CONFIG = {
    API_BASE: '/api',
    MARTIN_URL: '/tiles',
    WS_URL: '',
  };
  root.API_BASE = root.PS_CONFIG.API_BASE;
  root.PV_CONFIG_SOURCE = 'fallback';
})(window);
