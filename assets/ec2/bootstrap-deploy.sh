#!/bin/bash
# Deploys the current release on first boot if one has already been published.
# A brand-new environment has no artifact yet; that is not an error.
#
# Usage: bootstrap-deploy.sh <deployments-bucket> <key>
#   bootstrap-deploy.sh prod-ctech-deployments ctech-wallet/api/current.zip
set -euo pipefail

BUCKET="${1:?bootstrap-deploy.sh: deployments bucket required}"
KEY="${2:?bootstrap-deploy.sh: artifact key required}"

if aws s3api head-object --bucket "$BUCKET" --key "$KEY" >/dev/null 2>&1; then
  /opt/app/deploy.sh "$KEY"
else
  echo "No bootstrap artifact at s3://${BUCKET}/${KEY} — waiting for first deploy"
fi
