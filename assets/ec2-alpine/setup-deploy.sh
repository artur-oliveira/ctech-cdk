#!/bin/bash
# Installs /opt/app/deploy.sh, invoked by SSM RunCommand with the release key.
# Alpine/OpenRC equivalent of assets/ec2/setup-deploy.sh: fetches via
# ctech-ec2-agent, restarts via rc-service, and tails the app's own log file
# (OpenRC has no unified journal).
#
# Usage: setup-deploy.sh <deployments-bucket> <binary-name> <health-url> [extra binaries...]
set -euo pipefail

BUCKET="${1:?setup-deploy.sh: deployments bucket required}"
BINARY="${2:?setup-deploy.sh: binary name required}"
HEALTH_URL="${3:?setup-deploy.sh: health check URL required}"
shift 3
BINARIES="$BINARY $*"

mkdir -p /opt/app/releases

cat > /opt/app/deploy.sh << 'DEPLOY'
#!/bin/bash
set -euo pipefail

S3_KEY="${1:?deploy.sh: S3 key required}"
RELEASE_DIR="/opt/app/releases/$(date +%Y%m%d_%H%M%S)"
mkdir -p "$RELEASE_DIR"

echo "Downloading release: $S3_KEY"
ctech-ec2-agent s3-cp -bucket __BUCKET__ -key "$S3_KEY" -dest /tmp/release.zip
unzip -o /tmp/release.zip -d "$RELEASE_DIR"
for b in __BINARIES__; do chmod +x "$RELEASE_DIR/$b"; done
chown -R webapp:webapp "$RELEASE_DIR"
ln -sfT "$RELEASE_DIR" /opt/app/current

restart_and_wait() {
  local unit="$1" url="$2" log="$3"
  rc-service "$unit" restart
  for _ in {1..60}; do
    if curl -sf "$url" >/dev/null; then
      echo "$unit: health check passed"
      return 0
    fi
    if ! rc-service "$unit" status >/dev/null 2>&1; then
      echo "$unit: application failed to start"
      tail -n 100 "$log" || true
      exit 1
    fi
    sleep 2
  done
  curl -sf "$url" >/dev/null || { echo "$unit: timed out waiting for health check"; exit 1; }
}

if [ -f /opt/app/alt-port ]; then
  APP_PORT="$(cat /opt/app/app-port)"
  ALT_PORT="$(cat /opt/app/alt-port)"
  HEALTH_PATH="$(echo "__HEALTH_URL__" | sed -E 's#^[a-z]+://[^/]+##')"
  restart_and_wait app "http://127.0.0.1:${APP_PORT}${HEALTH_PATH}" /var/log/app/app.log
  restart_and_wait app2 "http://127.0.0.1:${ALT_PORT}${HEALTH_PATH}" /var/log/app/app2.log
else
  restart_and_wait app "__HEALTH_URL__" /var/log/app/app.log
fi

ls -dt /opt/app/releases/*/ 2>/dev/null | tail -n +2 | xargs rm -rf 2>/dev/null || true
echo "Deployment successful"
DEPLOY

sed -i \
  -e "s|__BUCKET__|${BUCKET}|g" \
  -e "s|__BINARIES__|${BINARIES}|g" \
  -e "s|__HEALTH_URL__|${HEALTH_URL}|g" \
  /opt/app/deploy.sh

chmod 0755 /opt/app/deploy.sh
