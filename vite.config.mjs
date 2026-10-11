// Vite build for the Parcel Viewer (/demo/) and Admin Console (/admin/) pages (DIC-2180).
//
// Vite hashes and minifies the pages' stylesheets into /assets/ (slice 2a). The scripts
// stay classic: Vite only bundles modules, and modules would change load timing and error
// isolation, so tools/vite/classic-scripts.mjs bundles each run of classic script tags
// into one classic script in /assets/ instead (slice 2b; its header has the rules). The
// web image still serves the script folders (infra/web.Dockerfile) for anything that
// loads a file by path, and the dev stack serves the source files unbundled.
//
// The pages link everything with root-absolute paths (/frontend/public/…, /admin/…), so
// the project root is the repo root.
import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import classicScripts from './tools/vite/classic-scripts.mjs';

const root = import.meta.dirname;

export default defineConfig({
  root,
  // Nothing is copied wholesale; the script and data folders are served by the image.
  publicDir: false,
  plugins: [classicScripts({ root })],
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
});
