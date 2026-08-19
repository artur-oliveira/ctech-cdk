#!/bin/bash
# Trusts the Cloudflare Origin CA RSA root on Amazon Linux 2023.
#
# Private clients reach HAProxy directly through *.internal.aoctech.app, so they
# receive its Cloudflare Origin CA server certificate without Cloudflare acting
# as the public TLS terminator. The root is downloaded from Cloudflare's official
# static URL and accepted only when its pinned SHA-256 matches — a root fetched
# over the network and trusted unverified is not a trust anchor.
#
# Usage: setup-cloudflare-ca.sh
set -euo pipefail

CA_URL="https://developers.cloudflare.com/ssl/static/origin_ca_rsa_root.pem"
CA_SHA256="91a8a5567efa6bf941162aa806b3ba476aaddf7867640e53053b35fb225a5dae"
ANCHOR=/etc/pki/ca-trust/source/anchors/cloudflare-origin-ca-rsa.pem

command -v curl >/dev/null || dnf install -y curl-minimal
command -v openssl >/dev/null || dnf install -y openssl

install -d -m 0755 /etc/pki/ca-trust/source/anchors

TMP="$(mktemp /tmp/cloudflare-origin-ca-rsa.XXXXXX.pem)"
trap 'rm -f "$TMP"' EXIT

curl --fail --silent --show-error --location \
  --retry 5 --retry-all-errors --connect-timeout 10 --max-time 60 \
  "$CA_URL" --output "$TMP"

echo "$CA_SHA256  $TMP" | sha256sum --check --strict
openssl x509 -in "$TMP" -noout -checkend 86400

# The ECC root was trusted by an earlier revision of this bootstrap and is no
# longer used; leaving it behind widens the trust store for no reason.
rm -f /etc/pki/ca-trust/source/anchors/cloudflare-origin-ca-ecc.pem
install -m 0644 "$TMP" "$ANCHOR"

update-ca-trust extract
