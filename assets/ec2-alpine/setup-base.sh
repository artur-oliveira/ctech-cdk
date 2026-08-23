#!/bin/bash
# Packages, the unprivileged service user, and the directory layout every
# CTech EC2 service shares — Alpine/apk equivalent of assets/ec2/setup-base.sh.
#
# Usage: setup-base.sh <service> [extra apk packages...]
#   setup-base.sh ctech-account nginx-openrc
set -euo pipefail

SERVICE="${1:?setup-base.sh: service name required}"
shift

apk add --no-cache amazon-ssm-agent amazon-ssm-agent-openrc unzip jq "$@"

# `adduser` returns 1 when the user already exists; the guard keeps a re-run
# green, same as the AL2023 script's useradd guard. Unlike AL2023's useradd,
# busybox adduser -S does not create a same-named group by default, so the
# later `chown webapp:webapp` fails with "unknown user/group" unless the
# group is created explicitly first.
id -u webapp >/dev/null 2>&1 || {
  addgroup -S webapp 2>/dev/null || true
  adduser -S -D -H -G webapp -s /sbin/nologin webapp
}

mkdir -p /opt/app/releases /var/log/app /etc/nginx/conf.d "/var/lib/$SERVICE"
chown -R webapp:webapp /opt/app /var/log/app "/var/lib/$SERVICE"

rc-update add amazon-ssm-agent default
rc-service amazon-ssm-agent start
