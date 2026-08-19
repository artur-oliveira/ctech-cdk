#!/bin/bash
# Installs an already-rendered CloudWatch agent config and activates it.
#
# The config itself stays in user data: its namespace and log group names are
# CloudFormation values, and buildCloudWatchAgentConfig in @aoctech/cdk is what
# produces them. Only the install and activation are shared here.
#
# Usage: setup-cloudwatch-agent.sh <config-file>
set -euo pipefail

CONFIG="${1:?setup-cloudwatch-agent.sh: config file path required}"
TARGET=/opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json

test -s "$CONFIG" || { echo "setup-cloudwatch-agent.sh: $CONFIG is missing or empty" >&2; exit 1; }

install -m 0644 "$CONFIG" "$TARGET"
/opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl -a fetch-config -m ec2 -c "file:$TARGET" -s
