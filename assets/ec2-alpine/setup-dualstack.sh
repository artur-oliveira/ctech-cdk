#!/bin/bash
# These instances have no public IPv4. Alpine equivalent of
# assets/ec2/setup-dualstack.sh: the SSM agent's own config file plus
# ctech-ec2-agent's OpenRC conf.d (OpenRC services read /etc/conf.d/<name>,
# not /etc/environment, when started).
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

mkdir -p /etc/conf.d
cat > /etc/conf.d/ctech-ec2-agent << 'AGENTENV'
export AWS_USE_DUALSTACK_ENDPOINT=true
AGENTENV
