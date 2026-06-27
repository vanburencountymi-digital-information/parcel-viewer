/**
 * pv-capabilities.js — runtime capability gating for the viewer (ISV keystone Phase 2).
 *
 * Phase 1 routed branding/map reads through window.PS_MANIFEST. Phase 2 starts CONSUMING
 * manifest.capabilities to show/hide viewer surfaces, and finally WIRES C4's per-tenant
 * feature flags (engine/feature-flags.js / DIC-585) into the live runtime: the effective
 * capability set is resolveCapabilities(PS_MANIFEST, flags) — the manifest tri-state with
 * per-tenant overrides layered on top (false = gate off / rollback, true = canary on,
 * {ai} = override). The manifest itself is never mutated.
 *
 * ADDITIVE / DEFAULT-ON: isEnabled(capId) returns true unless a capability that IS in the
 * manifest baseline gets removed by a flag. No manifest → no gating. A capId the manifest
 * doesn't declare is never gated (no regression on surfaces the manifest doesn't model yet).
 * Today's assembled manifest enables all 13 capabilities, so default behavior is unchanged;
 * gating only bites when a flag flips one off.
 *
 * Flags source (per-tenant), highest precedence first: window.PV_FEATURE_FLAGS, then a
 * localStorage 'pv-feature-flags' JSON override (per-browser, for ops/testing), then
 * COUNTY.featureFlags, else {}. (A future increment can source these from /api per tenant.)
 *
 * Exposes: window.PV_CAPS { isEnabled, resolved, flags, refresh }.
 */
(function (root) {
  'use strict';

  function lsFlags() {
    try {
      var raw = root.localStorage && root.localStorage.getItem('pv-feature-flags');
      if (!raw) return null;
      var o = JSON.parse(raw);
      return (o && typeof o === 'object') ? o : null;
    } catch (_) { return null; }
  }

  function flagsObj() {
    if (root.PV_FEATURE_FLAGS && typeof root.PV_FEATURE_FLAGS === 'object') return root.PV_FEATURE_FLAGS;
    var ls = lsFlags();
    if (ls) return ls;
    if (root.COUNTY && root.COUNTY.featureFlags && typeof root.COUNTY.featureFlags === 'object') return root.COUNTY.featureFlags;
    return {};
  }

  // The manifest's declared capability set (the baseline before flags). Null if no manifest.
  function baseline() {
    var m = root.PS_MANIFEST;
    return (m && m.capabilities && typeof m.capabilities === 'object') ? m.capabilities : null;
  }

  // The effective capability set = manifest capabilities with per-tenant flags applied.
  // Falls back to the raw baseline if feature-flags.js isn't loaded.
  function resolved() {
    var m = root.PS_MANIFEST;
    if (!m) return null;
    var ff = root.ISV_FEATURE_FLAGS;
    if (!ff || !ff.resolveCapabilities) return baseline();
    try { return ff.resolveCapabilities(m, flagsObj()); }
    catch (_) { return baseline(); }
  }

  function has(map, k) { return !!map && Object.prototype.hasOwnProperty.call(map, k); }

  // Is a capability enabled for this deployment? Default-on; only false when a manifest-
  // declared capability is removed by a flag.
  function isEnabled(capId) {
    var base = baseline();
    if (!base) return true;                 // no manifest gating active
    var res = resolved() || base;
    if (has(res, capId)) return true;       // present after flags → enabled
    if (has(base, capId)) return false;     // declared but removed by a flag → gated off
    return true;                            // not modeled by the manifest → never gate
  }

  // ── DOM gates this module owns (simple show/hide of static surfaces) ──────────
  // Tab/tool gating that needs the map panel lives in map.js; mount-time gating
  // (MapBuddy.mount) lives at the mount site. Here: the admin-menu items + the
  // mobile Map Buddy tab.
  var DOM_GATES = [
    { cap: 'print',    sel: '.pv-admin-item[data-tool="print"]' },
    { cap: 'share',    sel: '.pv-admin-item[data-tool="share"]' },
    { cap: 'mapBuddy', sel: '#pv-mtab-buddy' },
  ];

  function applyDomGates() {
    if (!root.document) return;
    DOM_GATES.forEach(function (g) {
      var on = isEnabled(g.cap);
      var els = root.document.querySelectorAll(g.sel);
      for (var i = 0; i < els.length; i++) {
        var el = els[i];
        el.hidden = !on;
        el.style.display = on ? '' : 'none';   // force-hide past any CSS display rule
      }
    });
  }

  // Recompute + re-apply (after flipping flags at runtime — used to demo/verify).
  function refresh() { applyDomGates(); return resolved(); }

  root.PV_CAPS = {
    isEnabled: isEnabled,
    resolved: resolved,
    flags: flagsObj,
    refresh: refresh,
  };

  if (root.document && root.document.readyState !== 'loading') applyDomGates();
  else if (root.document) root.document.addEventListener('DOMContentLoaded', applyDomGates);
}(typeof self !== 'undefined' ? self : this));
