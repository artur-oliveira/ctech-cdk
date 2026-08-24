#!/bin/bash
# These instances have no public IPv4. Alpine equivalent of
# assets/ec2/setup-dualstack.sh: the SSM agent's own config file, plus
# /etc/environment for anything that reads it directly. ctech-ec2-agent's
# own OpenRC services set AWS_USE_DUALSTACK_ENDPOINT themselves (in their
# per-service /etc/conf.d/<name>, written by setup-ctech-ec2-agent.sh and
# setup-app-service.sh) since openrc-run sources /etc/conf.d/$RC_SVCNAME —
# the exact service name, not a generic "ctech-ec2-agent" — so a file
# written here under that name would never be read.
#
# Usage: setup-dualstack.sh
set -euo pipefail

grep -q '^AWS_USE_DUALSTACK_ENDPOINT=true$' /etc/environment \
  || echo "AWS_USE_DUALSTACK_ENDPOINT=true" >> /etc/environment

mkdir -p /etc/amazon/ssm
cat > /etc/amazon/ssm/amazon-ssm-agent.json << 'SSMCFG'
{ "Agent": { "UseDualStackEndpoint": true } }
SSMCFG
rc-service amazon-ssm-agent restart
