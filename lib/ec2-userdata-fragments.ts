import * as ec2 from 'aws-cdk-lib/aws-ec2';

const CLOUDFLARE_ORIGIN_CA_RSA_URL =
  'https://developers.cloudflare.com/ssl/static/origin_ca_rsa_root.pem';
const CLOUDFLARE_ORIGIN_CA_RSA_SHA256 =
  '91a8a5567efa6bf941162aa806b3ba476aaddf7867640e53053b35fb225a5dae';

/**
 * Byte-identical UserData fragments shared by every private-IPv4-only EC2 service
 * (no public IPv4 → SSM agent and the CloudWatch agent must be told to use the
 * dual-stack endpoint, or they simply can't connect). Compose these into each
 * service's own `ec2.UserData` alongside its service-specific nginx.conf/start.sh.
 */

/** `AWS_USE_DUALSTACK_ENDPOINT` for the shell profile + the SSM agent's own config file. */
export function addDualStackSsmAgentCommands(userData: ec2.UserData): void {
  userData.addCommands(
    'echo "AWS_USE_DUALSTACK_ENDPOINT=true" >> /etc/environment',
    `mkdir -p /etc/amazon/ssm`,
    `cat > /etc/amazon/ssm/amazon-ssm-agent.json << 'SSM'`,
    `{ "Agent": { "UseDualStackEndpoint": true } }`,
    `SSM`,
    'systemctl enable amazon-ssm-agent',
    'systemctl restart amazon-ssm-agent',
  );
}

/**
 * Trusts the Cloudflare Origin CA RSA root on Amazon Linux 2023.
 *
 * Private clients reach HAProxy directly through *.internal.aoctech.app, so
 * they receive its Cloudflare Origin CA server certificate without Cloudflare
 * acting as the public TLS terminator. The root is downloaded from Cloudflare's
 * official static URL and accepted only when its pinned SHA-256 matches.
 */
export function addCloudflareOriginCaCommands(userData: ec2.UserData): void {
  userData.addCommands(
    '(',
    '  set -euo pipefail',
    '  command -v curl >/dev/null || dnf install -y curl-minimal',
    '  command -v openssl >/dev/null || dnf install -y openssl',
    '  install -d -m 0755 /etc/pki/ca-trust/source/anchors',
    '  CF_ORIGIN_CA_TMP="$(mktemp /tmp/cloudflare-origin-ca-rsa.XXXXXX.pem)"',
    `  trap 'rm -f "$CF_ORIGIN_CA_TMP"' EXIT`,
    `  curl --fail --silent --show-error --location --retry 5 --retry-all-errors --connect-timeout 10 --max-time 60 "${CLOUDFLARE_ORIGIN_CA_RSA_URL}" --output "$CF_ORIGIN_CA_TMP"`,
    `  echo "${CLOUDFLARE_ORIGIN_CA_RSA_SHA256}  $CF_ORIGIN_CA_TMP" | sha256sum --check --strict`,
    '  openssl x509 -in "$CF_ORIGIN_CA_TMP" -noout -checkend 86400',
    '  rm -f /etc/pki/ca-trust/source/anchors/cloudflare-origin-ca-ecc.pem',
    '  install -m 0644 "$CF_ORIGIN_CA_TMP" /etc/pki/ca-trust/source/anchors/cloudflare-origin-ca-rsa.pem',
    ') || { echo "Cloudflare Origin CA RSA installation failed" >&2; exit 1; }',
    'update-ca-trust extract || exit 1',
  );
}

/** systemd override so the CloudWatch agent process also picks up the dual-stack endpoint. */
export function addCloudWatchAgentDualStackOverride(userData: ec2.UserData): void {
  userData.addCommands(
    'mkdir -p /etc/systemd/system/amazon-cloudwatch-agent.service.d',
    `cat > /etc/systemd/system/amazon-cloudwatch-agent.service.d/override.conf << 'CWAENV'`,
    '[Service]',
    'Environment=AWS_USE_DUALSTACK_ENDPOINT=true',
    'CWAENV',
  );
}

/** N MB swap file — prevents OOM on t4g.micro (1 GB RAM) under memory pressure. */
export function addSwapCommands(userData: ec2.UserData, sizeMb: number = 256): void {
  userData.addCommands(
    'if [ ! -f /var/swapfile ]; then',
    `  dd if=/dev/zero of=/var/swapfile bs=1M count=${sizeMb}`,
    '  chmod 600 /var/swapfile',
    '  mkswap /var/swapfile',
    '  swapon /var/swapfile',
    '  echo "/var/swapfile swap swap defaults 0 0" >> /etc/fstab',
    'fi',
  );
}

/**
 * Writes /opt/app/update-realip.sh + a systemd oneshot service/daily timer, and runs
 * it once before nginx first starts.
 *
 * Without this, nginx's $remote_addr is the ALB's private IP: every client collapses
 * into one rate-limit bucket. Walking X-Forwarded-For right-to-left and discarding
 * only trusted hops (the ALB, then CloudFront's origin-facing ranges) is what makes
 * the resolved IP unforgeable — taking the leftmost entry instead would let a client
 * spoof the header. CloudFront's ranges change over time and have no AAAA record, so
 * they're fetched from the AWS-managed prefix list (reachable over the dual-stack
 * endpoint) rather than pinned in the template, and refreshed by a daily timer.
 *
 * Requires nginx.conf to `include /etc/nginx/conf.d/realip*.conf;` inside `http {}`.
 */
export function addRealipRefreshCommands(userData: ec2.UserData, vpcCidrBlock: string): void {
  userData.addCommands(
    `cat > /opt/app/update-realip.sh << 'REALIP'`,
    `#!/bin/bash`,
    `set -euo pipefail`,
    `CONF=/etc/nginx/conf.d/realip.conf`,
    `TMP=$(mktemp)`,
    // systemd units do not inherit /etc/environment, so the dual-stack opt-in
    // must be set here for the timer-driven runs.
    `export AWS_USE_DUALSTACK_ENDPOINT=true`,
    `PL_ID=$(aws ec2 describe-managed-prefix-lists --filters Name=prefix-list-name,Values=com.amazonaws.global.cloudfront.origin-facing --query 'PrefixLists[0].PrefixListId' --output text --region us-east-1)`,
    `if [ -z "$PL_ID" ] || [ "$PL_ID" = "None" ]; then`,
    `  echo "CloudFront origin-facing managed prefix list not found" >&2`,
    `  exit 1`,
    `fi`,
    `PREFIXES=$(aws ec2 get-managed-prefix-list-entries --prefix-list-id "$PL_ID" --query 'Entries[].Cidr' --output text --region us-east-1 | tr '\\t' '\\n')`,
    // A partial list is worse than the old file: an unlisted edge would be treated
    // as the client and become the rate-limit key. Bail and keep what we have.
    `if [ "$(echo "$PREFIXES" | grep -c .)" -lt 10 ]; then`,
    `  echo "Refusing to write realip.conf: only $(echo "$PREFIXES" | grep -c .) CloudFront prefixes returned" >&2`,
    `  exit 1`,
    `fi`,
    `{`,
    `  echo "# Generated by /opt/app/update-realip.sh — do not edit."`,
    `  echo "set_real_ip_from __VPC_CIDR__;"`,
    `  echo "$PREFIXES" | sed -e 's|^|set_real_ip_from |' -e 's|$|;|'`,
    `  echo "real_ip_header X-Forwarded-For;"`,
    `  echo "real_ip_recursive on;"`,
    `} > "$TMP"`,
    `install -m 644 "$TMP" "$CONF"`,
    `rm -f "$TMP"`,
    // nginx -t reads the live config, so a bad file is caught before it is served.
    `if ! nginx -t 2>/dev/null; then`,
    `  echo "nginx rejected the generated realip.conf — reverting" >&2`,
    `  rm -f "$CONF"`,
    `  exit 1`,
    `fi`,
    // Guarded with `if` rather than `&&`: under `set -e`, a false `&&` chain as the
    // last statement would exit non-zero on the bootstrap run, when nginx is not up yet.
    `if systemctl is-active --quiet nginx; then`,
    `  systemctl reload nginx`,
    `fi`,
    `REALIP`,
    `sed -i 's|__VPC_CIDR__|${vpcCidrBlock}|g' /opt/app/update-realip.sh`,
    `chmod +x /opt/app/update-realip.sh`,

    `cat > /etc/systemd/system/update-realip.service << 'REALIPSVC'`,
    `[Unit]`,
    `Description=Refresh nginx realip trusted proxy ranges`,
    `After=network-online.target`,
    `Wants=network-online.target`,
    ``,
    `[Service]`,
    `Type=oneshot`,
    `ExecStart=/opt/app/update-realip.sh`,
    `REALIPSVC`,

    `cat > /etc/systemd/system/update-realip.timer << 'REALIPTIMER'`,
    `[Unit]`,
    `Description=Daily refresh of nginx realip trusted proxy ranges`,
    ``,
    `[Timer]`,
    `OnCalendar=daily`,
    `RandomizedDelaySec=1h`,
    `Persistent=true`,
    ``,
    `[Install]`,
    `WantedBy=timers.target`,
    `REALIPTIMER`,

    // Generate the file before nginx first starts, so no request is ever served
    // with the ALB as the rate-limit key.
    `/opt/app/update-realip.sh || echo "realip bootstrap failed — rate limiting will key on the ALB until the timer succeeds"`,
    `systemctl daemon-reload`,
    `systemctl enable --now update-realip.timer`,
  );
}
