#!/bin/bash
# Installs ctech-ec2-agent and starts its logs-tail daemon under OpenRC.
# Replaces assets/ec2/setup-cloudwatch-agent.sh — logs only, per this
# repo's spec (docs/specs/2026-08-23-alpine-ec2-ami.md, non-goals: no metrics).
#
# Usage: setup-ctech-ec2-agent.sh <config-file> [service-suffix]
#   setup-ctech-ec2-agent.sh /tmp/ctech-logs.json
#   setup-ctech-ec2-agent.sh /tmp/ctech-logs-app.json app
#
# service-suffix lets a caller with more than one CloudWatch log group run
# this twice (logsTailConfig, ctech-ec2-agent/logstail.go, holds exactly one
# logGroup per config file) without the two OpenRC services colliding.
# Omitted, it keeps the original single-service name so the one existing
# consumer (ValkeyStackV2, one log group) is unaffected.
set -euo pipefail

CONFIG="${1:?setup-ctech-ec2-agent.sh: logs-tail config file path required}"
SUFFIX="${2:-}"
SERVICE_NAME="ctech-ec2-agent-logs${SUFFIX:+-$SUFFIX}"
CONFIG_DEST="/etc/ctech-ec2-agent/logs${SUFFIX:+-$SUFFIX}.json"

test -s "$CONFIG" || { echo "setup-ctech-ec2-agent.sh: $CONFIG is missing or empty" >&2; exit 1; }

mkdir -p /etc/ctech-ec2-agent /var/lib/ctech-ec2-agent
install -m 0644 "$CONFIG" "$CONFIG_DEST"

cat > "/etc/init.d/$SERVICE_NAME" << SVC
#!/sbin/openrc-run
description="ctech-ec2-agent logs-tail ($SERVICE_NAME)"
command="/usr/local/bin/ctech-ec2-agent"
command_args="logs-tail -config $CONFIG_DEST"
command_background="yes"
pidfile="/run/$SERVICE_NAME.pid"
supervisor="supervise-daemon"
respawn_delay=15
respawn_max=0

depend() {
	need net
	after amazon-ssm-agent
}
SVC
chmod 0755 "/etc/init.d/$SERVICE_NAME"

rc-update add "$SERVICE_NAME" default
rc-service "$SERVICE_NAME" start
