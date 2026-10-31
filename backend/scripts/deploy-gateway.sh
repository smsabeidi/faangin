#!/usr/bin/env bash
# Deploys gateway/ to Cloud Run as "faangin-gateway" from source and prints the service URL.
# Usage: scripts/deploy-gateway.sh <project> [region]
# Needs: gcloud (brew install --cask google-cloud-sdk), gcloud auth login, the OPENAI_API_KEY secret
# in Secret Manager with secretAccessor granted to the Cloud Run service account (docs/DEPLOY.md).
set -euo pipefail

PROJECT="${1:-}"
REGION="${2:-us-central1}"
if [[ -z "$PROJECT" ]]; then
  echo "usage: $0 <project> [region]" >&2
  exit 1
fi
command -v gcloud >/dev/null 2>&1 || { echo "gcloud is not installed: brew install --cask google-cloud-sdk" >&2; exit 1; }

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

gcloud run deploy faangin-gateway \
  --source "$ROOT/gateway" \
  --project "$PROJECT" \
  --region "$REGION" \
  --set-secrets OPENAI_API_KEY=OPENAI_API_KEY:latest \
  --allow-unauthenticated \
  --min-instances 0 \
  --max-instances 20 \
  --concurrency 80 \
  --timeout 3600 \
  --session-affinity

URL="$(gcloud run services describe faangin-gateway --project "$PROJECT" --region "$REGION" --format 'value(status.url)')"
echo
echo "faangin-gateway: $URL"
echo "Paste this as GATEWAY_BASE in the desktop app (client/README.md)."
