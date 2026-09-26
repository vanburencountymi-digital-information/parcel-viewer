#!/usr/bin/env bash
# Deploy Map Buddy microservice to Cloud Run (core-db-475718).
#
#   bash map-buddy/deploy.sh                      # from the repo root, on a clean, tagged checkout
#   VIEWER_ORIGINS=https://gis.vanburencountymi.gov bash map-buddy/deploy.sh
#
# Every setting below can be overridden from the environment. Settings this script
# doesn't manage (for example SENTRY_DSN, set once in the console) are left alone:
# it uses --update-env-vars, not --set-env-vars, which would wipe them (DIC-1871).
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

PROJECT_ID="${PROJECT_ID:-core-db-475718}"
REGION="${REGION:-us-central1}"
SERVICE="${SERVICE:-map-buddy}"

# Only ship committed code: the image tag is the commit, so it must describe the image.
if [ -n "$(git status --porcelain)" ] && [ "${ALLOW_DIRTY:-0}" != "1" ]; then
  echo "Refusing to deploy: the working tree has uncommitted changes (commit or stash them;" >&2
  echo "ALLOW_DIRTY=1 overrides, for emergencies only)." >&2
  exit 1
fi
GIT_SHA="$(git rev-parse --short=12 HEAD)"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/map-buddy/${SERVICE}:${GIT_SHA}"

# Browser origins allowed to call Map Buddy. gis.dicemi.org for the parallel rollout,
# gis.vanburencountymi.gov at launch (readiness checklist, B5). Comma-separated.
VIEWER_ORIGINS="${VIEWER_ORIGINS:-https://gis.dicemi.org}"
# Public Parcel API the agent's data tools call (DIC-1852). The in-code default
# (http://api:8000) only resolves inside docker compose, so Cloud Run must be told.
# nginx strips the /api/ prefix.
PARCEL_API_BASE="${PARCEL_API_BASE:-https://gis.dicemi.org/api}"
MAP_BUDDY_TENANT="${MAP_BUDDY_TENANT:-vanburen}"
# AI quota (DIC-1854): the quota is OFF unless AI_QUOTA_DEFAULT is set. Counted per
# tenant over a rolling AI_QUOTA_WINDOW (24h here); one /chat or explainer call = 1.
# Counters are in-memory per instance until the shared store lands (DIC-1862), so the
# effective ceiling is up to MAX_INSTANCES times this.
AI_QUOTA_DEFAULT="${AI_QUOTA_DEFAULT:-200}"
AI_QUOTA_WINDOW="${AI_QUOTA_WINDOW:-86400}"
MAX_INSTANCES="${MAX_INSTANCES:-3}"
# Requests per instance. Routes are sync and each /chat holds a worker thread for the
# whole model call, so keep this modest; Cloud Run adds instances up to MAX_INSTANCES.
CONCURRENCY="${CONCURRENCY:-20}"
# Seconds before Cloud Run cuts a request (its default, made explicit). Normal turns
# take seconds; the theoretical worst case (MAP_BUDDY_MAX_ITERS 6 x ANTHROPIC_TIMEOUT_S
# 60 x 2 tries) is longer, and this cap is what bounds it.
REQUEST_TIMEOUT="${REQUEST_TIMEOUT:-300}"

# The release tag becomes APP_VERSION (API version + Sentry release); ADR 0002.
APP_VERSION="${APP_VERSION:-$(git describe --tags --abbrev=0 2>/dev/null || echo 0.0.0)}"
APP_VERSION="${APP_VERSION#v}"

echo "==> Deploying ${SERVICE} ${APP_VERSION} (commit ${GIT_SHA}) to ${PROJECT_ID}/${REGION}"
echo "    origins=${VIEWER_ORIGINS}  parcel_api=${PARCEL_API_BASE}  tenant=${MAP_BUDDY_TENANT}"
echo "    quota=${AI_QUOTA_DEFAULT}/${AI_QUOTA_WINDOW}s  max_instances=${MAX_INSTANCES}  concurrency=${CONCURRENCY}"

echo "==> Configuring Docker auth..."
gcloud auth configure-docker "${REGION}-docker.pkg.dev" --quiet

echo "==> Building image..."
# Cloud Run runs linux/amd64; without this an Apple-silicon build won't start.
docker build --platform linux/amd64 --build-arg APP_VERSION="${APP_VERSION}" \
  -f map-buddy/backend/Dockerfile -t "${IMAGE}" map-buddy/backend/

echo "==> Pushing to Artifact Registry..."
docker push "${IMAGE}"

echo "==> Deploying to Cloud Run..."
# "^|^" switches the list separator to | so ALLOWED_ORIGINS can contain commas.
gcloud run deploy "${SERVICE}" \
  --image "${IMAGE}" \
  --region "${REGION}" \
  --project "${PROJECT_ID}" \
  --set-secrets ANTHROPIC_API_KEY=MAP_BUDDY_ANTHROPIC_API_KEY:latest \
  --update-env-vars "^|^ALLOWED_ORIGINS=${VIEWER_ORIGINS}|PARCEL_API_BASE=${PARCEL_API_BASE}|MAP_BUDDY_TENANT=${MAP_BUDDY_TENANT}|AI_QUOTA_DEFAULT=${AI_QUOTA_DEFAULT}|AI_QUOTA_WINDOW=${AI_QUOTA_WINDOW}" \
  --allow-unauthenticated \
  --port 8000 \
  --min-instances 0 \
  --max-instances "${MAX_INSTANCES}" \
  --concurrency "${CONCURRENCY}" \
  --timeout "${REQUEST_TIMEOUT}" \
  --memory 512Mi

echo ""
echo "==> Deployed! URL:"
gcloud run services describe "${SERVICE}" --region "${REGION}" --project "${PROJECT_ID}" --format "value(status.url)"
echo "Next: bash infra/smoke-test.sh <viewer-url>"
