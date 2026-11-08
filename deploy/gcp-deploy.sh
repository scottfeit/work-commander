#!/usr/bin/env bash
# Build the image with Cloud Build and apply the Terraform in deploy/terraform.
# Usage: deploy/gcp-deploy.sh <project_id> [region]
set -euo pipefail
PROJECT="${1:?project id}"
REGION="${2:-us-central1}"
NAME="${WC_NAME:-work-commander}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TAG="$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || date +%s)"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT}/${NAME}/app:${TAG}"

cd "$ROOT/deploy/terraform"
terraform init -upgrade
# First make sure the registry and APIs exist so the build can push.
terraform apply -var "project_id=${PROJECT}" -var "region=${REGION}" -var "image=${IMAGE}" \
  -target=google_project_service.apis -target=google_artifact_registry_repository.images

gcloud builds submit "$ROOT" --project "$PROJECT" --region "$REGION" --tag "$IMAGE"

terraform apply -var "project_id=${PROJECT}" -var "region=${REGION}" -var "image=${IMAGE}"
terraform output
