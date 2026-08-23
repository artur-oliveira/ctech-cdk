#!/bin/bash
# Installs ctech-ec2-agent and starts its logs-tail daemon under OpenRC.
# Replaces assets/ec2/setup-cloudwatch-agent.sh — logs only, per this
# repo's spec (docs/specs/2026-08-23-alpine-ec2-ami.md, non-goals: no metrics).
#
# Usage: setup-ctech-ec2-agent.sh <config-file>
#   setup-ctech-ec2-agent.sh /tmp/ctech-logs.json
set -euo pipefail

CONFIG="${1:?setup-ctech-ec2-agent.sh: logs-tail config file path required}"

test -s "$CONFIG" || { echo "setup-ctech-ec2-agent.sh: $CONFIG is missing or empty" >&2; exit 1; }

mkdir -p /etc/ctech-ec2-agent /var/lib/ctech-ec2-agent
install -m 0644 "$CONFIG" /etc/ctech-ec2-agent/logs.json

cat > /etc/init.d/ctech-ec2-agent-logs << 'SVC'
#!/sbin/openrc-run
description="ctech-ec2-agent logs-tail"
command="/usr/local/bin/ctech-ec2-agent"
command_args="logs-tail -config /etc/ctech-ec2-agent/logs.json"
command_background="yes"
pidfile="/run/ctech-ec2-agent-logs.pid"
supervisor="supervise-daemon"
respawn_delay=15
respawn_max=0

depend() {
	need net
	after amazon-ssm-agent
}
SVC
chmod 0755 /etc/init.d/ctech-ec2-agent-logs

rc-update add ctech-ec2-agent-logs default
rc-service ctech-ec2-agent-logs start
