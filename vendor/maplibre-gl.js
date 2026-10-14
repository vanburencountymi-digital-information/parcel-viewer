/**
 * maplibre-gl.js — MapLibre GL for the page, as the classic `window.maplibregl` (DIC-2379).
 *
 * Since 6.0, MapLibre ships only as ES modules (no UMD build), and the main library loads
 * its worker from a separate file it finds through import.meta.url. The build bundles this
 * entry into the classic library script (tools/vite/classic-scripts.mjs), where
 * import.meta.url doesn't exist, so the worker's URL is given explicitly: the `?url`
 * import publishes the worker as a content-hashed file in /assets/ and returns its path.
 * The app still reads the global (new maplibregl.Map(...)), as it did with the UMD build.
 */
import * as maplibregl from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';

// Absolute, so MapLibre's same-origin check and any `new URL(…)` it does need no base.
maplibregl.setWorkerUrl(new URL(workerUrl, window.location.href).href);
window.maplibregl = maplibregl;
