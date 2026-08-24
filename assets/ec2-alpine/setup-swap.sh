#!/bin/bash
# Alpine/OpenRC equivalent of assets/ec2/setup-swap.sh — same dd/mkswap/swapon
# sequence, no OS-specific step (util-linux's mkswap is already baked into
# the Alpine AMI by Packer for the addSwapCommands userdata fragment).
#
# Usage: setup-swap.sh [sizeMb]
set -euo pipefail

SIZE_MB="${1:-256}"

if [ -f /var/swapfile ]; then
  echo "setup-swap.sh: /var/swapfile already present, leaving it alone"
  exit 0
fi

dd if=/dev/zero of=/var/swapfile bs=1M count="$SIZE_MB"
chmod 600 /var/swapfile
mkswap /var/swapfile
swapon /var/swapfile

# Idempotent: a re-run with the file already in fstab must not duplicate the line.
grep -q '^/var/swapfile ' /etc/fstab || echo "/var/swapfile swap swap defaults 0 0" >> /etc/fstab
