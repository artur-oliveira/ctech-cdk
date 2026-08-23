import * as ec2 from 'aws-cdk-lib/aws-ec2';

const CLOUDFLARE_ORIGIN_CA_RSA_URL =
  'https://developers.cloudflare.com/ssl/static/origin_ca_rsa_root.pem';
const CLOUDFLARE_ORIGIN_CA_RSA_SHA256 =
  '91a8a5567efa6bf941162aa806b3ba476aaddf7867640e53053b35fb225a5dae';

/**
 * Alpine/OpenRC equivalents of lib/ec2-userdata-fragments.ts. `addSwapCommands`
 * is not duplicated here — it is already OS-agnostic, import it from
 * ec2-userdata-fragments.ts as-is.
 */

/** OpenRC equivalent of addDualStackSsmAgentCommands. */
export function addDualStackSsmAgentCommandsAlpine(userData: ec2.UserData): void {
  userData.addCommands(
    'echo "AWS_USE_DUALSTACK_ENDPOINT=true" >> /etc/environment',
    `mkdir -p /etc/amazon/ssm`,
    `cat > /etc/amazon/ssm/amazon-ssm-agent.json << 'SSM'`,
    `{ "Agent": { "UseDualStackEndpoint": true } }`,
    `SSM`,
    'rc-service amazon-ssm-agent restart',
  );
}

/** Alpine's trust store: update-ca-certificates, not RHEL's update-ca-trust. */
export function addCloudflareOriginCaCommandsAlpine(userData: ec2.UserData): void {
  userData.addCommands(
    '(',
    '  set -euo pipefail',
    '  command -v curl >/dev/null || apk add --no-cache curl',
    '  command -v openssl >/dev/null || apk add --no-cache openssl',
    '  install -d -m 0755 /usr/local/share/ca-certificates',
    '  CF_ORIGIN_CA_TMP="$(mktemp /tmp/cloudflare-origin-ca-rsa.XXXXXX.pem)"',
    `  trap 'rm -f "$CF_ORIGIN_CA_TMP"' EXIT`,
    `  curl --fail --silent --show-error --location --retry 5 --retry-all-errors --connect-timeout 10 --max-time 60 "${CLOUDFLARE_ORIGIN_CA_RSA_URL}" --output "$CF_ORIGIN_CA_TMP"`,
    `  echo "${CLOUDFLARE_ORIGIN_CA_RSA_SHA256}  $CF_ORIGIN_CA_TMP" | sha256sum -c -`,
    '  openssl x509 -in "$CF_ORIGIN_CA_TMP" -noout -checkend 86400',
    '  rm -f /usr/local/share/ca-certificates/cloudflare-origin-ca-ecc.crt',
    '  install -m 0644 "$CF_ORIGIN_CA_TMP" /usr/local/share/ca-certificates/cloudflare-origin-ca-rsa.crt',
    ') || { echo "Cloudflare Origin CA RSA installation failed" >&2; exit 1; }',
    'update-ca-certificates || exit 1',
  );
}
