#!/bin/bash
# Deploy Map Buddy microservice to Cloud Run (core-db-475718)
set -e

PROJECT_ID="core-db-475718"
REGION="us-central1"
SERVICE="map-buddy"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/map-buddy/${SERVICE}"
# Public Parcel API the agent's data tools call (DIC-1852). The in-code default
# (http://api:8000) only resolves inside docker compose, so Cloud Run must be told.
# nginx strips the /api/ prefix. Override if the live hostname differs.
PARCEL_API_BASE="${PARCEL_API_BASE:-https://parcels.dicemi.org/api}"
# AI quota (DIC-1854): the quota is OFF unless AI_QUOTA_DEFAULT is set. Counted per
# tenant over a rolling AI_QUOTA_WINDOW (24h here); one /chat or explainer call = 1.
# Counters are still in-memory per instance (x --max-instances) until the shared store
# lands (DIC-1862), so the effective daily ceiling is up to 3x this. Override to tune.
AI_QUOTA_DEFAULT="${AI_QUOTA_DEFAULT:-200}"
AI_QUOTA_WINDOW="${AI_QUOTA_WINDOW:-86400}"

echo "==> Configuring Docker auth..."
gcloud auth configure-docker ${REGION}-docker.pkg.dev --quiet

echo "==> Building image..."
docker build -f map-buddy/backend/Dockerfile -t ${IMAGE} map-buddy/backend/

echo "==> Pushing to Artifact Registry..."
docker push ${IMAGE}

echo "==> Deploying to Cloud Run..."
gcloud run deploy ${SERVICE} \
  --image ${IMAGE} \
  --region ${REGION} \
  --project ${PROJECT_ID} \
  --set-secrets ANTHROPIC_API_KEY=MAP_BUDDY_ANTHROPIC_API_KEY:latest \
  --set-env-vars "^|^ALLOWED_ORIGINS=https://map.dicemi.org,https://parcels.dicemi.org|PARCEL_API_BASE=${PARCEL_API_BASE}|MAP_BUDDY_TENANT=vanburen|AI_QUOTA_DEFAULT=${AI_QUOTA_DEFAULT}|AI_QUOTA_WINDOW=${AI_QUOTA_WINDOW}" \
  --allow-unauthenticated \
  --port 8000 \
  --min-instances 0 \
  --max-instances 3 \
  --memory 512Mi

echo ""
echo "==> Deployed! URL:"
gcloud run services describe ${SERVICE} --region ${REGION} --project ${PROJECT_ID} --format "value(status.url)"
