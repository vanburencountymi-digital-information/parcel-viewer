# syntax=docker/dockerfile:1
# The Parcel Viewer's web image (DIC-2180): nginx serving the built pages and the same
# script, engine and data folders the live-source dev stack serves. Built on deploy (no
# registry yet, per Drake), so the host needs Docker only, no Node.
#
#   docker build -f infra/web.Dockerfile -t parcel-viewer-web .      # from the repo root
#
# Step 1 (slice 2a): Vite builds the /demo/ and /admin/ pages and their CSS (/assets/,
# content-hashed); the scripts are still the classic files, served from their folders.
# nginx's per-environment includes (api-upstream, map-buddy-api) are mounted by compose;
# the image carries production defaults so it also starts on its own.

FROM node:22-alpine AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY vite.config.mjs ./
COPY demo ./demo
COPY admin ./admin
COPY frontend/public ./frontend/public
RUN npm run build

FROM nginx:1.27-alpine
# The built pages and assets.
COPY --from=build /src/dist/demo/ /usr/share/nginx/html/demo/
COPY --from=build /src/dist/admin/ /usr/share/nginx/html/admin/
COPY --from=build /src/dist/assets/ /usr/share/nginx/html/assets/
# What the pages still load or fetch by path, laid out as the dev stack mounts it.
COPY frontend/public/ /usr/share/nginx/html/parcel-viewer/
COPY admin/js/ /usr/share/nginx/html/admin/js/
COPY engine/ /usr/share/nginx/html/engine/
COPY map-buddy/js/ /usr/share/nginx/html/map-buddy/js/
COPY map-buddy/css/ /usr/share/nginx/html/map-buddy/css/
# nginx config, with production defaults for the per-environment includes.
COPY infra/nginx.viewer.conf /etc/nginx/conf.d/default.conf
COPY infra/nginx/map-buddy-api.prod.conf /etc/nginx/pv/map-buddy-api.conf
COPY infra/nginx/api-upstream.fastapi.conf /etc/nginx/pv/api-upstream.conf
