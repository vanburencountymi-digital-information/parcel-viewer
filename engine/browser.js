/**
 * browser.js — the Parcel Viewer page's engine entry (DIC-2180 slice 3).
 *
 * The build bundles this into a classic script (tools/vite/classic-scripts.mjs), so the
 * engine is on window synchronously, before the viewer scripts after it run.
 */
import { viewerHooks } from './window-hooks.js';

Object.assign(window, viewerHooks);
