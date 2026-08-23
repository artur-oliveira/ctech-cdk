#!/bin/bash
# Deploys the current release on first boot if one has already been
# published. Alpine equivalent of assets/ec2/bootstrap-deploy.sh, checking
# for an artifact via ctech-ec2-agent instead of the AWS CLI.
#
# Usage: bootstrap-deploy.sh <deployments-bucket> <key>
set -euo pipefail

BUCKET="${1:?bootstrap-deploy.sh: deployments bucket required}"
KEY="${2:?bootstrap-deploy.sh: artifact key required}"

if ctech-ec2-agent s3-head -bucket "$BUCKET" -key "$KEY" >/dev/null 2>&1; then
  /opt/app/deploy.sh "$KEY"
else
  echo "No bootstrap artifact at s3://${BUCKET}/${KEY} — waiting for first deploy"
fi
