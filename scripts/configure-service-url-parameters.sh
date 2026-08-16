#!/usr/bin/env bash
set -euo pipefail

environment="${1:-prod}"
ctech_aws_profile="${CTECH_AWS_PROFILE:-ctech}"
ctech_aws_region="${CTECH_AWS_REGION:-us-east-1}"

case "$environment" in
  prod)
    public_suffix=""
    internal_suffix=""
    ;;
  dev|stage)
    public_suffix="-$environment"
    internal_suffix="-$environment"
    ;;
  *)
    echo "usage: $0 [dev|stage|prod]" >&2
    exit 2
    ;;
esac

put_url() {
  local name="$1"
  local value="$2"
  local description="$3"
  aws --profile "$ctech_aws_profile" --region "$ctech_aws_region" ssm put-parameter \
    --name "$name" \
    --type String \
    --tier Standard \
    --value "$value" \
    --description "$description" \
    --overwrite >/dev/null
  echo "$name = $value"
}

account_internal="https://accounts${internal_suffix}.internal.aoctech.app"
dfe_internal="https://dfe${internal_suffix}.internal.aoctech.app"
wallet_internal="https://wallet${internal_suffix}.internal.aoctech.app"
poker_internal="https://poker${internal_suffix}.internal.aoctech.app"
billing_internal="https://billing${internal_suffix}.internal.aoctech.app"

# Keep ctech-account's existing base-url/app-url values untouched: they define
# the public OAuth issuer and browser redirect contract. These two parameters
# are transport-only endpoints used by workloads running inside the VPC.
put_url "/ctech-account/$environment/internal-base-url" "$account_internal" \
  "Private ctech-account API endpoint through CTech HAProxy"
put_url "/ctech-account/$environment/internal-jwks-url" \
  "$account_internal/.well-known/jwks.json" \
  "Private ctech-account JWKS endpoint through CTech HAProxy"

put_url "/ctech-dfe/$environment/app-url" \
  "https://dfe${public_suffix}.aoctech.app" \
  "Public DFE audience and browser origin"
put_url "/ctech-dfe/$environment/internal-base-url" "$dfe_internal" \
  "Private DFE API endpoint through CTech HAProxy"

# Billing's own root (terraform/billing) owns its DNS record and publishes its
# secrets, but not this: the URL is what *other* services need in order to reach
# it, and every one of those lives here rather than in the callee's state.
put_url "/ctech-billing/$environment/internal-base-url" "$billing_internal" \
  "Private billing API endpoint through CTech HAProxy"

put_url "/ctech-wallet/$environment/app-url" \
  "https://wallet${public_suffix}.aoctech.app" \
  "Public wallet audience and browser origin"
put_url "/ctech-wallet/$environment/internal-base-url" "$wallet_internal" \
  "Private wallet API endpoint through CTech HAProxy"

put_url "/ctech/$environment/poker/app-url" \
  "https://poker${public_suffix}.aoctech.app" \
  "Public poker audience and browser origin"
put_url "/ctech/$environment/poker/internal-base-url" "$poker_internal" \
  "Private poker API endpoint through CTech HAProxy"
put_url "/ctech/$environment/poker/avatar-base-url" \
  "https://poker${public_suffix}.aoctech.app/avatars" \
  "Public same-origin base URL for versioned poker avatars"
put_url "/ctech/$environment/poker/wallet-internal-url" "$wallet_internal" \
  "Private wallet endpoint used by poker EC2"
