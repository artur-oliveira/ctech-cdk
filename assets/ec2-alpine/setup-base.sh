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

# Alpine's official cloud image ships chronyd pointed only at the default
# internet NTP pool — this VPC has no NAT/internet egress for arbitrary
# hosts, so every source
# sits at Reach 0 forever and the clock free-runs on whatever drift estimate
# chronyd last computed (or none at all). Confirmed live (2026-09-04): a
# poker-api instance ~16h past a Spot replacement had drifted ~23s behind
# real time — enough for every persisted turn/next-hand deadline (an
# absolute unix-ms timestamp, not a monotonic duration) to already read as
# expired by the time a client received it. 169.254.169.123 is the Amazon
# Time Sync Service's link-local address: served by the hypervisor, reachable
# from any EC2 instance with no security group, NACL or internet egress
# involved. A stale /var/lib/chrony/chrony.drift left over from a prior boot
# is removed first so a fresh sync is never blended with an old frequency
# estimate computed under different conditions. chronyc waitsync is bounded
# and non-fatal: a slow or failed sync should not hang boot, but the app
# should not start visibly mis-clocked either — see docs/specs.
cat > /etc/chrony/chrony.conf <<'CHRONYCONF'
server 169.254.169.123 prefer iburst minpoll 4 maxpoll 4
driftfile /var/lib/chrony/chrony.drift
rtcsync
cmdport 0
CHRONYCONF
rm -f /var/lib/chrony/chrony.drift
rc-service chronyd restart
chronyc waitsync 30 0.1 0 15 || echo "WARNING: chronyd did not confirm sync within 30s, continuing boot" >&2
