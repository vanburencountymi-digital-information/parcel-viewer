/**
 * window-hooks.js — the engine's browser globals, named in one place (DIC-2180 slice 3).
 *
 * The engine is ES modules; the viewer's own scripts are still classic and read the
 * engine through these window.ISV_* names (they move to imports file by file). The page
 * entries (browser.js, browser-admin.js) put them on window, and the render tests put
 * them on their sandbox, so both see exactly what this file lists.
 *
 * Only the modules the pages load are here: ai-quality.js and tenant.js are Node-only.
 */
import ISV from './capability.js';
import ISV_CONTEXT from './app-context.js';
import ISV_SELECTION from './selection.js';
import ISV_HIGHLIGHT from './feature-highlight.js';
import ISV_SOURCE from './source.js';
import ISV_POPUP from './popup.js';
import ISV_DOC from './doc.js';
import ISV_CITATION from './citation.js';
import ISV_EXPLAINER_CORE from './capabilities/explainer.core.js';
import ISV_LEDGER_CORE from './capabilities/ledger.core.js';
import ISV_THEME_COMPOSER_CORE from './capabilities/theme-composer.core.js';
import ISV_COHORT_ANALYZE_CORE from './capabilities/cohort-analyze.core.js';
import ISV_REGISTER from './capabilities/register.js';
import ISV_MANIFEST_VERSION from './manifest-version.js';
import ISV_VALIDATE_MANIFEST from './validate-manifest.js';
import ISV_LOAD_MANIFEST from './load-manifest.js';
import ISV_CAPABILITY_CATALOG from './capability-catalog.js';
import ISV_MANIFEST_ASSEMBLE from './manifest-assemble.js';
import ISV_FEATURE_FLAGS from './feature-flags.js';

/** Every hook the Parcel Viewer page sets (the 19 engine files it used to load). */
export const viewerHooks = {
  ISV,
  ISV_CONTEXT,
  ISV_SELECTION,
  ISV_HIGHLIGHT,
  ISV_SOURCE,
  ISV_POPUP,
  ISV_DOC,
  ISV_CITATION,
  ISV_EXPLAINER_CORE,
  ISV_LEDGER_CORE,
  ISV_THEME_COMPOSER_CORE,
  ISV_COHORT_ANALYZE_CORE,
  ISV_REGISTER,
  ISV_MANIFEST_VERSION,
  ISV_VALIDATE_MANIFEST,
  ISV_LOAD_MANIFEST,
  ISV_CAPABILITY_CATALOG,
  ISV_MANIFEST_ASSEMBLE,
  ISV_FEATURE_FLAGS,
};

/** The Admin Console's subset (the 6 engine files it used to load). */
export const adminHooks = {
  ISV_MANIFEST_VERSION,
  ISV_VALIDATE_MANIFEST,
  ISV_LOAD_MANIFEST,
  ISV_CAPABILITY_CATALOG,
  ISV_MANIFEST_ASSEMBLE,
  ISV_THEME_COMPOSER_CORE,
};

/**
 * Put the viewer's hooks on `target` (window, or a test sandbox) and register the v1
 * capabilities into the page's shared registry (ISV.registry), once. Consumers like
 * the viewer's ledger window call ISV.invoke(), which rejects with "unknown capability" until this
 * runs (DIC-2266). The registry is one per module instance, so a second call is a no-op.
 */
export function installViewerHooks(target) {
  Object.assign(target, viewerHooks);
  if (!ISV.get('ledger')) ISV_REGISTER.registerAll(ISV.registry);
  return target;
}
