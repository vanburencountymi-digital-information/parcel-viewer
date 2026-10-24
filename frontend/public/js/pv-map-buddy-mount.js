/**
 * pv-map-buddy-mount.js — mounts Map Buddy (was an inline script in demo/index.html; a file
 * so the CSP's script-src needs no 'unsafe-inline', DIC-2556). Loads right after
 * /map-buddy/js/map-buddy.js, synchronously, as the inline script did.
 *
 * Map Buddy runs as a standalone Cloud Run service; its URL comes from county config
 * via pv-endpoints.js (DIC-1856), the same resolution every AI module uses.
 */
(function () {
  var apiBase = PV_ENDPOINTS.mapBuddyBase();
  // Capability gating (Phase 2): only mount Map Buddy when the manifest/feature-flags
  // enable it. Default-on (PV_CAPS absent → mount). The B1 AI-mode toggle still governs
  // on/off visibility separately; this governs whether the surface exists at all.
  if (!window.PV_CAPS || PV_CAPS.isEnabled('mapBuddy')) {
    MapBuddy.mount({ apiBase: apiBase });
  }
})();
