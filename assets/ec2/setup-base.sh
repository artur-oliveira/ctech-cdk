#!/bin/bash
# Packages, the unprivileged service user, and the directory layout every CTech
# EC2 service shares.
#
# Usage: setup-base.sh <service> [extra dnf packages...]
#   setup-base.sh ctech-account nginx
#   setup-base.sh ctech-poker
set -euo pipefail

SERVICE="${1:?setup-base.sh: service name required}"
shift

dnf install -y amazon-cloudwatch-agent amazon-ssm-agent cronie unzip jq "$@"

# `useradd` fails with status 9 when the user exists; the guard keeps a re-run green.
id -u webapp >/dev/null 2>&1 || useradd --system --no-create-home --shell /sbin/nologin webapp

mkdir -p /opt/app/releases /var/log/app /etc/nginx/conf.d "/var/lib/$SERVICE"
chown -R webapp:webapp /opt/app /var/log/app "/var/lib/$SERVICE"

# AL2023 does not enable crond by default (unlike AL2) — without it
# /etc/cron.daily/logrotate never fires and rotated logs never reach S3.
systemctl enable --now crond
