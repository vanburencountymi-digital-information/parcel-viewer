/**
 * load-manifest.js — the canonical "load a manifest" seam (C2 / DIC-583).
 *
 * MIGRATE-ON-LOAD: composes the two existing C2 pieces into the one entry point every
 * consumer (engine boot, Theme Composer/B2, the Admin Console store) should call to turn
 * a RAW stored manifest into a usable one:
 *
 *     loadManifest(raw) -> migrate(raw) up to CURRENT_VERSION  THEN  validate()
 *
 * So an OLD stored config is auto-upgraded to the current shape and only THEN checked
 * against the schema rules — i.e. "an old stored config still renders" (the C2 acceptance)
 * is enforced in one place instead of each caller remembering to migrate before it validates.
 *
 * A manifest is rejected (ok:false) if it can't migrate (newer-than-supported, no path,
 * not an object) OR if the migrated result fails validation. The migrated manifest is
 * still returned on a validation failure so a caller can surface what it tried to load.
 *
 * Validation is the existing zero-dep structural validator (validate-manifest.js). Full
 * JSON-Schema (Ajv) validation is a deliberately DEFERRED, isolated decision — pulling a
 * dependency cuts against the zero-dep harness + no-build-tool frontend ethos. When that
 * lands, only validate-manifest.js changes; this seam's contract stays put.
 *
 * ES module (DIC-2180): imported by the harness and, in the browser, put on
 * window.ISV_LOAD_MANIFEST by engine/window-hooks.js.
 */
import MV from './manifest-version.js';
import VALIDATE from './validate-manifest.js';

const mod = (function () {
  'use strict';

  // loadManifest(raw) -> {
  //   ok,                       // migrated AND valid
  //   manifest,                 // the migrated manifest (present whenever migration ran)
  //   fromVersion, toVersion,   // version migrated from → to (engine's CURRENT_VERSION)
  //   applied,                  // ['0.9→1.0', ...] migration steps applied
  //   errors                    // [] when ok; migration error or validation errors otherwise
  // }
  function loadManifest(raw) {
    if (!MV || !VALIDATE) {
      // Engine bundle incomplete (e.g. a script didn't load in the browser). Fail loud
      // rather than silently passing an unmigrated/unvalidated manifest downstream.
      return { ok: false, errors: ['load-manifest: manifest-version/validate-manifest not available'] };
    }

    var mig = MV.migrate(raw);
    if (!mig.ok) {
      return {
        ok: false,
        fromVersion: mig.fromVersion,
        toVersion: mig.toVersion,
        applied: [],
        errors: [mig.error],
      };
    }

    var res = VALIDATE.validate(mig.manifest);
    return {
      ok: res.valid,
      manifest: mig.manifest,
      fromVersion: mig.fromVersion,
      toVersion: mig.toVersion,
      applied: mig.applied,
      errors: res.valid ? [] : res.errors,
    };
  }

  return { loadManifest: loadManifest };
})();

export { mod as default, mod as 'module.exports' };
