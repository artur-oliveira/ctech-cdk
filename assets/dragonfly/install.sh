#!/bin/bash
# Stages the official DragonflyDB aarch64 release binary for the CDK asset.
# Runs inside the bundling container; /asset-output is what CDK zips and uploads.
#
# Building from source needed a recursive submodule clone and a full C++ compile
# on every synth of the whole app. The project publishes a release binary that
# links only glibc and libz, so this just downloads and verifies it — no arm64
# emulation, no toolchain image.
#
# Version and digest live here on purpose: the asset hash is the hash of this
# directory, so editing either is what invalidates the S3 object and versions the
# launch template. Bumping DRAGONFLY_VERSION in the CDK alone would not.
set -euo pipefail

VERSION=1.40.1
SHA256=45c26a549bf91bc49a313e20dbd5a554993678a02513240f284c4ac3ae4616f8
URL="https://github.com/dragonflydb/dragonfly/releases/download/v${VERSION}/dragonfly-aarch64.tar.gz"

command -v curl >/dev/null || dnf install -y --setopt=install_weak_deps=False curl-minimal
command -v tar >/dev/null || dnf install -y --setopt=install_weak_deps=False tar gzip

curl -fsSL -o /tmp/dragonfly.tar.gz "$URL"

# The container is usually x86_64, so the binary cannot be run here to check it.
# The pinned digest is the only integrity gate this stage has.
echo "${SHA256}  /tmp/dragonfly.tar.gz" | sha256sum -c -

tar -xzf /tmp/dragonfly.tar.gz -C /tmp dragonfly-aarch64
install -D -m 0755 /tmp/dragonfly-aarch64 /asset-output/dragonfly
