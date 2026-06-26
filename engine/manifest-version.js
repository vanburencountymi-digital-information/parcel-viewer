/**
 * manifest-version.js — manifest SCHEMA versioning + migration (C2 / DIC-583).
 *
 * `manifestVersion` versions the SHAPE of the manifest (distinct from config-instance
 * versioning — a county's values with draft/publish/rollback — which the Admin Console
 * store owns). The engine declares the version it reads natively (CURRENT_VERSION) and
 * AUTO-UPGRADES older instances (vN-1 → vN) so deployed viewers don't break on engine
 * updates (§5.2). A version newer than the engine supports is rejected, not guessed.
 *
 * Migrations are an ordered chain of pure { from, to, migrate } steps. To evolve the
 * shape: bump CURRENT_VERSION, append a migration step, and update the JSON Schema.
 *
 * UMD: Node module (harness) + browser global (window.ISV_MANIFEST_VERSION).
 */
(function (root, factory) {
  'use strict';
  var mod = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
  root.ISV_MANIFEST_VERSION = mod;
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var CURRENT_VERSION = '1.0';

  // "X.Y" comparison → -1 | 0 | 1.
  function compareVersions(a, b) {
    var pa = String(a || '0.0').split('.').map(Number);
    var pb = String(b || '0.0').split('.').map(Number);
    for (var i = 0; i < Math.max(pa.length, pb.length); i++) {
      var x = pa[i] || 0, y = pb[i] || 0;
      if (x !== y) return x < y ? -1 : 1;
    }
    return 0;
  }

  // Capabilities whose default AI mode is 'ai-optional' (the 0.9→1.0 migration turned a
  // flat list of enabled capabilities into per-capability config carrying an AI mode).
  // Everything not listed defaults to 'no-ai' — the conservative floor.
  var _AI_OPTIONAL = { explainer: 1, visionDescribe: 1, cogo: 1, mapBuddy: 1, citations: 1 };
  function defaultAi(id) { return _AI_OPTIONAL[id] ? 'ai-optional' : 'no-ai'; }

  // Ordered migration chain. Each step transforms a manifest of version `from` into one
  // of version `to`. Pure: returns a new object, never mutates the input.
  var MIGRATIONS = [
    {
      from: '0.9', to: '1.0',
      migrate: function (m) {
        var out = {};
        for (var k in m) if (Object.prototype.hasOwnProperty.call(m, k)) out[k] = m[k];
        // capabilities: array of enabled ids → object with per-capability AI tri-state.
        if (Array.isArray(m.capabilities)) {
          var caps = {};
          m.capabilities.forEach(function (id) {
            caps[id] = { ai: defaultAi(id) };
          });
          out.capabilities = caps;
        }
        out.manifestVersion = '1.0';
        return out;
      },
    },
  ];

  // Migrate a manifest up to CURRENT_VERSION. Returns
  //   { ok, manifest, fromVersion, toVersion, applied:[...], error? }
  // Missing manifestVersion is treated as the OLDEST known shape so legacy configs
  // (pre-versioning) still upgrade.
  function migrate(manifest) {
    if (manifest == null || typeof manifest !== 'object') {
      return { ok: false, error: 'manifest must be an object' };
    }
    var from = manifest.manifestVersion || (MIGRATIONS[0] ? MIGRATIONS[0].from : CURRENT_VERSION);
    var cmp = compareVersions(from, CURRENT_VERSION);
    if (cmp > 0) {
      return { ok: false, fromVersion: from, toVersion: CURRENT_VERSION,
        error: 'manifestVersion ' + from + ' is newer than the engine supports (' + CURRENT_VERSION + ')' };
    }

    var cur = manifest;
    var version = from;
    var applied = [];
    var guard = 0;
    while (compareVersions(version, CURRENT_VERSION) < 0) {
      if (++guard > 50) return { ok: false, error: 'migration chain did not converge' };
      var step = MIGRATIONS.filter(function (s) { return s.from === version; })[0];
      if (!step) {
        return { ok: false, fromVersion: from, toVersion: CURRENT_VERSION,
          error: 'no migration path from manifestVersion ' + version };
      }
      cur = step.migrate(cur);
      version = step.to;
      applied.push(step.from + '→' + step.to);
    }
    return { ok: true, manifest: cur, fromVersion: from, toVersion: CURRENT_VERSION, applied: applied };
  }

  function isSupported(version) {
    if (compareVersions(version, CURRENT_VERSION) > 0) return false;
    if (compareVersions(version, CURRENT_VERSION) === 0) return true;
    // older → supported only if a migration path exists from it.
    var v = version;
    var guard = 0;
    while (compareVersions(v, CURRENT_VERSION) < 0) {
      if (++guard > 50) return false;
      var step = MIGRATIONS.filter(function (s) { return s.from === v; })[0];
      if (!step) return false;
      v = step.to;
    }
    return true;
  }

  return {
    CURRENT_VERSION: CURRENT_VERSION,
    compareVersions: compareVersions,
    migrate: migrate,
    isSupported: isSupported,
    MIGRATIONS: MIGRATIONS,
  };
}));
