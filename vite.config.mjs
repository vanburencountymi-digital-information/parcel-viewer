// Vite build for the Parcel Viewer (/demo/) and Admin Console (/admin/) pages (DIC-2180).
//
// Vite hashes and minifies the pages' stylesheets into /assets/ (slice 2a). The scripts
// stay classic: Vite only bundles modules, and modules would change load timing and error
// isolation, so tools/vite/classic-scripts.mjs bundles each run of script tags into one
// classic script in /assets/ instead (slice 2b; its header has the rules). An ES module
// entry in a run (engine/browser.js, slice 3) is bundled by Rolldown into that script.
// The dev stack serves this build too: `npm run dev` runs it with --watch.
//
// Vue (DIC-2389, ADR 0017): each page's <script type="module"> entry (frontend/src/main.js
// for the viewer, frontend/src/admin-main.js for the console) is Vite's own: the classic-scripts plugin leaves module tags alone, and @vitejs/plugin-vue
// compiles its .vue components. Vitest runs their tests (frontend/src/**/*.test.js).
//
// The pages link everything with root-absolute paths (/frontend/public/…, /admin/…), so
// the project root is the repo root.
import { resolve } from 'node:path';
import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';
import classicScripts from './tools/vite/classic-scripts.mjs';

const root = import.meta.dirname;

export default defineConfig({
  root,
  // Nothing is copied wholesale; the script and data folders are served by the image.
  publicDir: false,
  plugins: [classicScripts({ root }), vue()],
  build: {
    outDir: resolve(root, 'dist'),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        demo: resolve(root, 'demo/index.html'),
        admin: resolve(root, 'admin/index.html'),
      },
    },
  },
  test: {
    include: ['frontend/src/**/*.test.js'],
    environment: 'happy-dom',
  },
});
