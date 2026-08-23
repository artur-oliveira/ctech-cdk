#!/bin/bash
# Trusts the Cloudflare Origin CA RSA root — Alpine equivalent of
# assets/ec2/setup-cloudflare-ca.sh. Alpine's trust-store mechanism differs
# from RHEL's, not just the package manager: `update-ca-certificates` reading
# certs installed under /usr/local/share/ca-certificates/.
#
# Usage: setup-cloudflare-ca.sh
set -euo pipefail

CA_URL="https://developers.cloudflare.com/ssl/static/origin_ca_rsa_root.pem"
CA_SHA256="91a8a5567efa6bf941162aa806b3ba476aaddf7867640e53053b35fb225a5dae"
ANCHOR=/usr/local/share/ca-certificates/cloudflare-origin-ca-rsa.crt

command -v curl >/dev/null || apk add --no-cache curl
command -v openssl >/dev/null || apk add --no-cache openssl
apk add --no-cache ca-certificates

install -d -m 0755 /usr/local/share/ca-certificates

TMP="$(mktemp /tmp/cloudflare-origin-ca-rsa.XXXXXX.pem)"
trap 'rm -f "$TMP"' EXIT

curl --fail --silent --show-error --location \
  --retry 5 --retry-all-errors --connect-timeout 10 --max-time 60 \
  "$CA_URL" --output "$TMP"

echo "$CA_SHA256  $TMP" | sha256sum -c -
openssl x509 -in "$TMP" -noout -checkend 86400

rm -f /usr/local/share/ca-certificates/cloudflare-origin-ca-ecc.crt
install -m 0644 "$TMP" "$ANCHOR"

update-ca-certificates
