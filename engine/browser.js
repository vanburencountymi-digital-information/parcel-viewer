/**
 * browser.js — the Parcel Viewer page's engine entry (DIC-2180 slice 3).
 *
 * The build bundles this into a classic script (tools/vite/classic-scripts.mjs), so the
 * engine is on window synchronously, before the viewer scripts after it run. It also
 * registers the v1 capabilities, so ISV.invoke() works from the first viewer script.
 */
import { installViewerHooks } from './window-hooks.js';

installViewerHooks(window);
