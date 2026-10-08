// Vite build for the Parcel Viewer (/demo/) and Admin Console (/admin/) pages (DIC-2180).
//
// Step 1 of the build (slice 2a): only the pages and their stylesheets go through Vite,
// which hashes and minifies the CSS into /assets/. The scripts are untouched: they stay
// classic <script src> tags in today's order (Vite leaves non-module scripts alone), and
// the web image serves their folders as before (infra/web.Dockerfile). Bundling them is
// slice 2b, which has to keep load timing, per-file error isolation and the baked-then-
// served county config order (see the PR for DIC-2180).
//
// The pages link everything with root-absolute paths (/frontend/public/…, /admin/…), so
// the project root is the repo root.
import { resolve } from 'node:path';
import { defineConfig } from 'vite';

const root = import.meta.dirname;

export default defineConfig({
  root,
  // Nothing is copied wholesale; the script and data folders are served by the image.
  publicDir: false,
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
