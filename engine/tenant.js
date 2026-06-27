/**
 * tenant.js — the canonical tenant key + tenant→DB-county mapping (ISV keystone, DIC-582).
 *
 * Three spellings of "Van Buren" exist across the stack: the manifest assembler used to slug
 * COUNTY.name → `van-buren-county`; the Admin Console uses `vanburen` (COUNTY_KEY); the DB
 * `county` column / RLS uses `VBC`. Nothing consumed the tenant yet, so this was harmless —
 * but Phase 2 (per-tenant feature flags + AI quotas) and the C1 RLS (`SET app.current_tenant`)
 * need ONE canonical key plus a mapping to the DB value.
 *
 * DECISION (2026-06-27, confirmed with the team): the canonical tenant key is the manifest's
 * `tenant` field, spelled to match the §5.1 spec example AND the Admin Console COUNTY_KEY —
 * e.g. `vanburen`. The `van-buren-county` slug is demoted to the assembler's FALLBACK only
 * (when no tenant is configured), never the canonical key. The DB `county` code (`VBC`) is a
 * deployment fact resolved through TENANT_DB_COUNTY here.
 *
 * This module is the single place that owns:
 *   - canonicalTenant(manifest) → the canonical tenant key from a manifest (or null).
 *   - dbCounty(tenant)          → the DB `county` value RLS keys on (`SET app.current_tenant`),
 *                                 or null if unknown (fail-closed — caller must not default to
 *                                 "all tenants").
 *   - register(tenant, county)  → add/override a mapping (deployment seam; new counties).
 *
 * Source-agnostic: holds no domain field names, only the tenant registry data. The map is the
 * one place a new county's DB code is declared, so RLS, quotas, and flags resolve consistently.
 *
 * UMD: Node module (harness) + browser global (window.ISV_TENANT).
 */
(function (root, factory) {
  'use strict';
  var mod = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
  root.ISV_TENANT = mod;
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Canonical tenant key → DB `county` code (the value RLS sets as app.current_tenant).
  // Seeded with the one live deployment; new counties register their code at deploy time.
  var TENANT_DB_COUNTY = {
    vanburen: 'VBC',
  };

  function norm(s) { return String(s == null ? '' : s).trim(); }

  // The canonical tenant key carried by a manifest (§5: manifest.tenant). Null if absent.
  function canonicalTenant(manifest) {
    if (!manifest || typeof manifest !== 'object') return null;
    var t = norm(manifest.tenant);
    return t || null;
  }

  // Resolve a canonical tenant key to its DB `county` value. Returns null for an unknown or
  // empty tenant — callers MUST treat null as fail-closed (set no tenant / return no rows),
  // never as "match everything".
  function dbCounty(tenant) {
    var t = norm(tenant);
    if (!t) return null;
    return Object.prototype.hasOwnProperty.call(TENANT_DB_COUNTY, t) ? TENANT_DB_COUNTY[t] : null;
  }

  // Register/override a tenant→DB-county mapping (a new county at deploy time).
  function register(tenant, county) {
    var t = norm(tenant), c = norm(county);
    if (!t || !c) throw new Error('register(tenant, county): both required');
    TENANT_DB_COUNTY[t] = c;
    return c;
  }

  // Known canonical tenant keys (for diagnostics / admin listing).
  function tenants() { return Object.keys(TENANT_DB_COUNTY); }

  return {
    canonicalTenant: canonicalTenant,
    dbCounty: dbCounty,
    register: register,
    tenants: tenants,
  };
}));
