#!/usr/bin/env bash
#
# Build the demo site and deploy it to S3 + invalidate CloudFront.
#
# Hosting model: private S3 bucket behind CloudFront (OAC), the same as the portfolio.
# The site is served at a subdomain root; CloudFront's Origin Path points at the
# "rate-limiter" prefix, so Vite's base stays "/" and no path rewriting is needed in the app.
# A CloudFront Function serves folder URLs such as /how-it-works/ (deploy/cloudfront-function.js,
# decision 0035).
#
# Config can be overridden with environment variables, or by creating a gitignored
# scripts/deploy.config.local (see DEPLOY.md). At minimum you must provide
# CLOUDFRONT_DISTRIBUTION_ID.

set -euo pipefail

# ---- Config (env overrides win) --------------------------------------------
BUCKET="${DEPLOY_BUCKET:-kylewillett.com}"
PREFIX="${DEPLOY_PREFIX:-rate-limiter}"
REGION="${DEPLOY_REGION:-us-east-1}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Load gitignored local overrides (e.g. CLOUDFRONT_DISTRIBUTION_ID) if present.
if [ -f "$SCRIPT_DIR/deploy.config.local" ]; then
  # shellcheck disable=SC1091
  source "$SCRIPT_DIR/deploy.config.local"
fi

# ---- Preconditions ---------------------------------------------------------
command -v aws >/dev/null 2>&1 || {
  echo "error: aws CLI not found. Install and configure it (aws configure)." >&2
  exit 1
}

: "${CLOUDFRONT_DISTRIBUTION_ID:?Set CLOUDFRONT_DISTRIBUTION_ID (env var or scripts/deploy.config.local)}"

# Without the key the build succeeds and the site works, but PostHog never loads, so a deploy
# would quietly stop counting visits.
[ -f "$ROOT_DIR/demo/.env.local" ] || {
  echo "error: demo/.env.local is missing. Copy demo/.env.example and set the PostHog key." >&2
  exit 1
}

DEST="s3://${BUCKET}/${PREFIX}"
DIST="demo/dist"

cd "$ROOT_DIR"

# ---- Build -----------------------------------------------------------------
echo "==> Building (npm run demo:build)..."
npm run demo:build

# ---- Upload ----------------------------------------------------------------
# 1) Everything except the HTML pages: content-hashed filenames, cache forever.
#    --delete removes stale objects (old bundles) under the prefix.
echo "==> Syncing assets to ${DEST}/ (immutable, 1y cache)..."
aws s3 sync "${DIST}/" "${DEST}/" \
  --region "$REGION" \
  --delete \
  --exclude "*.html" \
  --cache-control "public, max-age=31536000, immutable"

# 2) The pages (index.html and how-it-works/index.html): no caching, so a new deploy is picked
#    up immediately. They're the only files whose names never change.
echo "==> Uploading HTML pages (no-cache)..."
aws s3 sync "${DIST}/" "${DEST}/" \
  --region "$REGION" \
  --exclude "*" \
  --include "*.html" \
  --cache-control "no-cache" \
  --content-type "text/html"

# ---- Invalidate CloudFront -------------------------------------------------
# Viewers hit the subdomain root, so the viewer-facing paths are "/*".
echo "==> Invalidating CloudFront (${CLOUDFRONT_DISTRIBUTION_ID})..."
aws cloudfront create-invalidation \
  --distribution-id "$CLOUDFRONT_DISTRIBUTION_ID" \
  --paths "/*" \
  --query 'Invalidation.{Id:Id,Status:Status}' \
  --output table

echo "==> Done. New version will be live once the invalidation completes (usually <1 min)."
