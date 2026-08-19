#!/bin/bash
# These instances have no public IPv4. Without the dual-stack opt-in the SSM and
# CloudWatch agents cannot reach their endpoints at all, and the failure presents
# as an instance that booted cleanly and is unreachable.
#
# Three clients need telling separately: the shell profile (for the AWS CLI in
# every other script), the SSM agent's own config file, and the CloudWatch agent's
# systemd unit — systemd units do not read /etc/environment.
#
# Usage: setup-dualstack.sh
set -euo pipefail

grep -q '^AWS_USE_DUALSTACK_ENDPOINT=true$' /etc/environment \
  || echo "AWS_USE_DUALSTACK_ENDPOINT=true" >> /etc/environment

mkdir -p /etc/amazon/ssm
cat > /etc/amazon/ssm/amazon-ssm-agent.json << 'SSMCFG'
{ "Agent": { "UseDualStackEndpoint": true } }
SSMCFG
systemctl enable amazon-ssm-agent
systemctl restart amazon-ssm-agent

mkdir -p /etc/systemd/system/amazon-cloudwatch-agent.service.d
cat > /etc/systemd/system/amazon-cloudwatch-agent.service.d/override.conf << 'CWAENV'
[Service]
Environment=AWS_USE_DUALSTACK_ENDPOINT=true
CWAENV
systemctl daemon-reload
