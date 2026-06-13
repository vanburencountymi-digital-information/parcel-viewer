#!/bin/bash
# Deploy Map Buddy microservice to Cloud Run (core-db-475718)
set -e

PROJECT_ID="core-db-475718"
REGION="us-central1"
SERVICE="map-buddy"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/map-buddy/${SERVICE}"

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
  --set-secrets ANTHROPIC_API_KEY=PS_ANTHROPIC_API_KEY:latest \
  --set-env-vars "^|^ALLOWED_ORIGINS=https://map.dicemi.org,https://parcels.dicemi.org,http://localhost:8080,http://localhost:5173" \
  --allow-unauthenticated \
  --port 8000 \
  --min-instances 0 \
  --max-instances 3 \
  --memory 512Mi

echo ""
echo "==> Deployed! URL:"
gcloud run services describe ${SERVICE} --region ${REGION} --project ${PROJECT_ID} --format "value(status.url)"
