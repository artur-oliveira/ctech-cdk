# EC2 User-Data Assets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move every shared EC2 bootstrap step out of inline `ec2.UserData` and into versioned shell scripts distributed from S3, so a service's user data is a short list of script invocations.

**Architecture:** `ctech-cdk` ships the scripts as plain files under `assets/ec2/`. A new `Ec2ScriptsStack` publishes them to `${env}-ctech-ec2-scripts` under a content-hash prefix and records the bucket and hash in SSM. An `Ec2ScriptRunner` construct reads both parameters at synthesis, emitting a `ctech_run` shell function whose S3 prefix is literal in the launch template — so editing a script versions the launch template and triggers an instance refresh. Terraform repositories read the same two SSM parameters and emit the same prelude.

**Tech Stack:** AWS CDK v2 (TypeScript), `aws-cdk-lib/aws-s3-deployment`, `aws-cdk-lib/aws-s3-assets`, Node's built-in `node:test`, Bash 5 on Amazon Linux 2023 (aarch64), Terraform for `ctech-billing` and `ctech-lbalancer`.

**Spec:** `docs/specs/2026-08-18-ec2-user-data-assets.md`

## Global Constraints

- Target OS is Amazon Linux 2023 minimal, `arm64`. `dnf`, `systemd`, Bash 5.
- Every script under `assets/ec2/` starts with `#!/bin/bash` and `set -euo pipefail`, takes all variable input as positional arguments or from `/etc/bootstrap.env`, and contains no CDK or Terraform templating.
- Every script must be idempotent: rerunning it on a booted instance converges rather than fails.
- Scripts are downloaded to a file and then executed. Never `aws s3 cp … | bash` — a truncated pipe runs a partial script and reports success.
- SSM parameter paths live in `lib/constants.ts` and are exported through `lib/index.ts`. Renaming one is a cross-repository breaking change.
- New SSM paths: `/ctech/{env}/ec2-scripts/bucket` and `/ctech/{env}/ec2-scripts/version`.
- Bucket name: `${environment}-ctech-ec2-scripts`.
- Instances need exactly one new IAM permission: `s3:GetObject` on `arn:aws:s3:::${env}-ctech-ec2-scripts/*`.
- ASG schedule defaults: `disableCron: '0 22 * * *'`, `enableCron: '0 10 * * *'`, `timeZone: 'America/Sao_Paulo'`, applied to every environment including production.
- Existing `add*Commands` fragments in `lib/ec2-userdata-fragments.ts` stay exported and working until every repository has migrated. They are not deleted in this plan.
- `npm test` in `ctech-cdk` runs `node --require ts-node/register --test test/*.test.ts`.
- Commit messages use Conventional Commits. Never add a `Co-Authored-By` trailer.

---

## File Structure

**Created in `ctech-cdk`:**

| Path | Responsibility |
| --- | --- |
| `assets/ec2/setup-base.sh` | Packages, `webapp` user, directories, `crond` |
| `assets/ec2/setup-swap.sh` | Swap file |
| `assets/ec2/setup-dualstack.sh` | `AWS_USE_DUALSTACK_ENDPOINT` for shell, SSM agent, CloudWatch agent |
| `assets/ec2/setup-cloudflare-ca.sh` | Cloudflare Origin CA RSA root, SHA-256 pinned |
| `assets/ec2/setup-realip.sh` | `update-realip.sh` + systemd oneshot + daily timer |
| `assets/ec2/setup-nginx.sh` | Shared `nginx.conf` |
| `assets/ec2/setup-cloudwatch-agent.sh` | Install config and `fetch-config` |
| `assets/ec2/setup-app-service.sh` | `app.service` + generic `/opt/app/start.sh` |
| `assets/ec2/setup-ssm-env.sh` | Generate `/opt/app/load-ssm-env.sh` from `VAR=/path` pairs |
| `assets/ec2/setup-deploy.sh` | `/opt/app/deploy.sh` |
| `assets/ec2/setup-logs.sh` | `/opt/app/upload-logs.sh` + logrotate stanza |
| `assets/ec2/bootstrap-deploy.sh` | First-boot deploy of `current.zip` if present |
| `lib/ec2-scripts-stack.ts` | Bucket, `BucketDeployment`, SSM parameters |
| `lib/ec2-script-runner.ts` | `Ec2ScriptRunner` construct |
| `test/ec2-scripts.test.ts` | Shell lint + runner/stack synthesis assertions |

**Modified in `ctech-cdk`:** `lib/constants.ts`, `lib/types.ts`, `lib/index.ts`, `lib/haproxy-ec2-service.ts`, `lib/valkey-stack.ts`, `lib/cloudwatch-agent-config.ts`, `bin/ctech-cdk.ts`, `package.json`, `README.md`, `CLAUDE.md`, `tsconfig.build.json`.

**Modified in service repositories:** `ctech-dfe/cdk/lib/api-stack.ts`, `ctech-account/cdk/lib/compute-stack.ts`, `ctech-wallet/cdk/lib/api-stack.ts`, `ctech-poker/cdk/lib/api-stack.ts`, `ctech-billing/terraform/assets/bootstrap.sh.tftpl`, `ctech-lbalancer/assets/bootstrap.sh.tftpl`.

---

## Task 1: Script directory and shell lint harness

Nothing downstream is safe to write until a broken script fails a test. This task adds the directory, one trivial script, and the lint test that will guard every script added afterwards.

**Files:**
- Create: `ctech-cdk/assets/ec2/setup-swap.sh`
- Create: `ctech-cdk/test/ec2-scripts.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: the `assets/ec2/` directory contract — every `*.sh` in it is syntax-checked by `test/ec2-scripts.test.ts`.

- [ ] **Step 1: Write the failing test**

Create `ctech-cdk/test/ec2-scripts.test.ts`:

```ts
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readdirSync, readFileSync} from 'node:fs';
import * as path from 'node:path';
import {test} from 'node:test';

const ASSETS_DIR = path.join(__dirname, '..', 'assets', 'ec2');

const scriptNames = () => readdirSync(ASSETS_DIR).filter((f) => f.endsWith('.sh')).sort();

test('every EC2 asset script parses under bash', () => {
  const names = scriptNames();
  assert.ok(names.length > 0, 'expected at least one script in assets/ec2');
  for (const name of names) {
    execFileSync('bash', ['-n', path.join(ASSETS_DIR, name)], {stdio: 'pipe'});
  }
});

test('every EC2 asset script sets the strict shell options', () => {
  for (const name of scriptNames()) {
    const body = readFileSync(path.join(ASSETS_DIR, name), 'utf8');
    assert.match(body, /^#!\/bin\/bash$/m, `${name}: missing bash shebang`);
    assert.match(body, /^set -euo pipefail$/m, `${name}: missing set -euo pipefail`);
  }
});

test('no EC2 asset script contains CDK or Terraform templating', () => {
  for (const name of scriptNames()) {
    const body = readFileSync(path.join(ASSETS_DIR, name), 'utf8');
    assert.doesNotMatch(body, /\$\{Token\[/, `${name}: contains a CDK token`);
    assert.doesNotMatch(body, /\$\{\s*[a-z_]+\s*\}\s*#\s*terraform/i, `${name}: contains Terraform templating`);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ctech-cdk && npm test`
Expected: FAIL — `ENOENT: no such file or directory, scandir '.../assets/ec2'`.

- [ ] **Step 3: Write the first script**

Create `ctech-cdk/assets/ec2/setup-swap.sh`:

```bash
#!/bin/bash
# N MB swap file — prevents OOM on t4g.micro (1 GB RAM) under memory pressure.
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ctech-cdk && npm test`
Expected: PASS for the three new tests, plus the existing `shared-components` tests.

- [ ] **Step 5: Commit**

```bash
git add assets/ec2/setup-swap.sh test/ec2-scripts.test.ts
git commit -m "feat(ec2): add shared user-data script directory with shell lint harness"
```

---

## Task 2: Base and dual-stack scripts

**Files:**
- Create: `ctech-cdk/assets/ec2/setup-base.sh`
- Create: `ctech-cdk/assets/ec2/setup-dualstack.sh`
- Modify: `ctech-cdk/test/ec2-scripts.test.ts`

**Interfaces:**
- Consumes: the lint harness from Task 1.
- Produces: `setup-base.sh <service> [extra-dnf-packages…]` and `setup-dualstack.sh` (no arguments). After `setup-base.sh`, `/opt/app/releases`, `/var/log/app` and `/var/lib/<service>` exist and are owned by `webapp`.

- [ ] **Step 1: Write the failing test**

Append to `ctech-cdk/test/ec2-scripts.test.ts`:

```ts
test('setup-base.sh requires a service name and enables crond', () => {
  const body = readFileSync(path.join(ASSETS_DIR, 'setup-base.sh'), 'utf8');
  assert.match(body, /SERVICE="\$\{1:\?/, 'service name must be a required argument');
  assert.match(body, /systemctl enable --now crond/);
  assert.match(body, /useradd --system --no-create-home --shell \/sbin\/nologin webapp/);
});

test('setup-dualstack.sh opts every AWS client into the dual-stack endpoint', () => {
  const body = readFileSync(path.join(ASSETS_DIR, 'setup-dualstack.sh'), 'utf8');
  assert.match(body, /\/etc\/environment/);
  assert.match(body, /\/etc\/amazon\/ssm\/amazon-ssm-agent\.json/);
  assert.match(body, /amazon-cloudwatch-agent\.service\.d\/override\.conf/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ctech-cdk && npm test`
Expected: FAIL — `ENOENT` reading `setup-base.sh`.

- [ ] **Step 3: Write the scripts**

Create `ctech-cdk/assets/ec2/setup-base.sh`:

```bash
#!/bin/bash
# Packages, the unprivileged service user, and the directory layout every CTech
# EC2 service shares.
#
# Usage: setup-base.sh <service> [extra dnf packages...]
#   setup-base.sh ctech-account nginx
#   setup-base.sh ctech-poker
set -euo pipefail

SERVICE="${1:?setup-base.sh: service name required}"
shift

dnf install -y amazon-cloudwatch-agent amazon-ssm-agent cronie unzip jq "$@"

# `useradd` fails with status 9 when the user exists; the guard keeps a re-run green.
id -u webapp >/dev/null 2>&1 || useradd --system --no-create-home --shell /sbin/nologin webapp

mkdir -p /opt/app/releases /var/log/app /etc/nginx/conf.d "/var/lib/$SERVICE"
chown -R webapp:webapp /opt/app /var/log/app "/var/lib/$SERVICE"

# AL2023 does not enable crond by default (unlike AL2) — without it
# /etc/cron.daily/logrotate never fires and rotated logs never reach S3.
systemctl enable --now crond
```

Create `ctech-cdk/assets/ec2/setup-dualstack.sh`:

```bash
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ctech-cdk && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add assets/ec2/setup-base.sh assets/ec2/setup-dualstack.sh test/ec2-scripts.test.ts
git commit -m "feat(ec2): add base and dual-stack bootstrap scripts"
```

---

## Task 3: Cloudflare Origin CA script

**Files:**
- Create: `ctech-cdk/assets/ec2/setup-cloudflare-ca.sh`
- Modify: `ctech-cdk/test/ec2-scripts.test.ts`

**Interfaces:**
- Consumes: nothing beyond the lint harness.
- Produces: `setup-cloudflare-ca.sh` (no arguments). Installs `/etc/pki/ca-trust/source/anchors/cloudflare-origin-ca-rsa.pem`.

- [ ] **Step 1: Write the failing test**

Append to `ctech-cdk/test/ec2-scripts.test.ts`:

```ts
test('setup-cloudflare-ca.sh pins the official RSA root by SHA-256', () => {
  const body = readFileSync(path.join(ASSETS_DIR, 'setup-cloudflare-ca.sh'), 'utf8');
  assert.match(body, /origin_ca_rsa_root\.pem/);
  assert.match(body, /91a8a5567efa6bf941162aa806b3ba476aaddf7867640e53053b35fb225a5dae/);
  assert.match(body, /sha256sum --check --strict/);
  assert.match(body, /openssl x509 .*-checkend 86400/);
  assert.match(body, /update-ca-trust extract/);
  assert.doesNotMatch(body, /BEGIN CERTIFICATE|origin_ca_ecc_root\.pem/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ctech-cdk && npm test`
Expected: FAIL — `ENOENT` reading `setup-cloudflare-ca.sh`.

- [ ] **Step 3: Write the script**

Create `ctech-cdk/assets/ec2/setup-cloudflare-ca.sh`:

```bash
#!/bin/bash
# Trusts the Cloudflare Origin CA RSA root on Amazon Linux 2023.
#
# Private clients reach HAProxy directly through *.internal.aoctech.app, so they
# receive its Cloudflare Origin CA server certificate without Cloudflare acting
# as the public TLS terminator. The root is downloaded from Cloudflare's official
# static URL and accepted only when its pinned SHA-256 matches — a root fetched
# over the network and trusted unverified is not a trust anchor.
#
# Usage: setup-cloudflare-ca.sh
set -euo pipefail

CA_URL="https://developers.cloudflare.com/ssl/static/origin_ca_rsa_root.pem"
CA_SHA256="91a8a5567efa6bf941162aa806b3ba476aaddf7867640e53053b35fb225a5dae"
ANCHOR=/etc/pki/ca-trust/source/anchors/cloudflare-origin-ca-rsa.pem

command -v curl >/dev/null || dnf install -y curl-minimal
command -v openssl >/dev/null || dnf install -y openssl

install -d -m 0755 /etc/pki/ca-trust/source/anchors

TMP="$(mktemp /tmp/cloudflare-origin-ca-rsa.XXXXXX.pem)"
trap 'rm -f "$TMP"' EXIT

curl --fail --silent --show-error --location \
  --retry 5 --retry-all-errors --connect-timeout 10 --max-time 60 \
  "$CA_URL" --output "$TMP"

echo "$CA_SHA256  $TMP" | sha256sum --check --strict
openssl x509 -in "$TMP" -noout -checkend 86400

# The ECC root was trusted by an earlier revision of this bootstrap and is no
# longer used; leaving it behind widens the trust store for no reason.
rm -f /etc/pki/ca-trust/source/anchors/cloudflare-origin-ca-ecc.pem
install -m 0644 "$TMP" "$ANCHOR"

update-ca-trust extract
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ctech-cdk && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add assets/ec2/setup-cloudflare-ca.sh test/ec2-scripts.test.ts
git commit -m "feat(ec2): add Cloudflare Origin CA bootstrap script"
```

---

## Task 4: realip refresh script

**Files:**
- Create: `ctech-cdk/assets/ec2/setup-realip.sh`
- Modify: `ctech-cdk/test/ec2-scripts.test.ts`

**Interfaces:**
- Consumes: nothing beyond the lint harness.
- Produces: `setup-realip.sh <vpc-cidr>`. Writes `/opt/app/update-realip.sh`, `update-realip.service`, `update-realip.timer`, and generates `/etc/nginx/conf.d/realip.conf` once. Must run before nginx first starts.

- [ ] **Step 1: Write the failing test**

Append to `ctech-cdk/test/ec2-scripts.test.ts`:

```ts
test('setup-realip.sh refuses a partial CloudFront prefix list and requires a CIDR', () => {
  const body = readFileSync(path.join(ASSETS_DIR, 'setup-realip.sh'), 'utf8');
  assert.match(body, /VPC_CIDR="\$\{1:\?/, 'VPC CIDR must be a required argument');
  assert.match(body, /com\.amazonaws\.global\.cloudfront\.origin-facing/);
  assert.match(body, /-lt 10/, 'must bail when fewer than 10 CloudFront prefixes come back');
  assert.match(body, /real_ip_recursive on/);
  assert.match(body, /systemctl enable --now update-realip\.timer/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ctech-cdk && npm test`
Expected: FAIL — `ENOENT` reading `setup-realip.sh`.

- [ ] **Step 3: Write the script**

Create `ctech-cdk/assets/ec2/setup-realip.sh`:

```bash
#!/bin/bash
# Installs /opt/app/update-realip.sh plus a systemd oneshot and daily timer, and
# runs it once before nginx first starts.
#
# Without this, nginx's $remote_addr is HAProxy's private IP: every client
# collapses into one rate-limit bucket. Walking X-Forwarded-For right-to-left and
# discarding only trusted hops (HAProxy, then CloudFront's origin-facing ranges)
# is what makes the resolved IP unforgeable — taking the leftmost entry instead
# would let a client spoof the header. CloudFront's ranges change over time and
# have no AAAA record, so they come from the AWS-managed prefix list rather than
# being pinned here, and are refreshed daily.
#
# Requires nginx.conf to `include /etc/nginx/conf.d/realip*.conf;` inside http {}.
#
# Usage: setup-realip.sh <vpc-ipv4-cidr>
set -euo pipefail

VPC_CIDR="${1:?setup-realip.sh: VPC IPv4 CIDR required}"

mkdir -p /opt/app /etc/nginx/conf.d

cat > /opt/app/update-realip.sh << 'REALIP'
#!/bin/bash
set -euo pipefail
CONF=/etc/nginx/conf.d/realip.conf
TMP=$(mktemp)
# systemd units do not inherit /etc/environment, so the dual-stack opt-in must be
# set here for the timer-driven runs.
export AWS_USE_DUALSTACK_ENDPOINT=true
PL_ID=$(aws ec2 describe-managed-prefix-lists \
  --filters Name=prefix-list-name,Values=com.amazonaws.global.cloudfront.origin-facing \
  --query 'PrefixLists[0].PrefixListId' --output text --region us-east-1)
if [ -z "$PL_ID" ] || [ "$PL_ID" = "None" ]; then
  echo "CloudFront origin-facing managed prefix list not found" >&2
  exit 1
fi
PREFIXES=$(aws ec2 get-managed-prefix-list-entries --prefix-list-id "$PL_ID" \
  --query 'Entries[].Cidr' --output text --region us-east-1 | tr '\t' '\n')
# A partial list is worse than the old file: an unlisted edge would be treated as
# the client and become the rate-limit key. Bail and keep what we have.
if [ "$(echo "$PREFIXES" | grep -c .)" -lt 10 ]; then
  echo "Refusing to write realip.conf: only $(echo "$PREFIXES" | grep -c .) CloudFront prefixes returned" >&2
  exit 1
fi
{
  echo "# Generated by /opt/app/update-realip.sh — do not edit."
  echo "set_real_ip_from __VPC_CIDR__;"
  echo "$PREFIXES" | sed -e 's|^|set_real_ip_from |' -e 's|$|;|'
  echo "real_ip_header X-Forwarded-For;"
  echo "real_ip_recursive on;"
} > "$TMP"
install -m 644 "$TMP" "$CONF"
rm -f "$TMP"
# nginx -t reads the live config, so a bad file is caught before it is served.
if ! nginx -t 2>/dev/null; then
  echo "nginx rejected the generated realip.conf — reverting" >&2
  rm -f "$CONF"
  exit 1
fi
# Guarded with `if` rather than `&&`: under `set -e` a false `&&` chain as the
# last statement exits non-zero on the bootstrap run, when nginx is not up yet.
if systemctl is-active --quiet nginx; then
  systemctl reload nginx
fi
REALIP

sed -i "s|__VPC_CIDR__|${VPC_CIDR}|g" /opt/app/update-realip.sh
chmod +x /opt/app/update-realip.sh

cat > /etc/systemd/system/update-realip.service << 'REALIPSVC'
[Unit]
Description=Refresh nginx realip trusted proxy ranges
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/opt/app/update-realip.sh
REALIPSVC

cat > /etc/systemd/system/update-realip.timer << 'REALIPTIMER'
[Unit]
Description=Daily refresh of nginx realip trusted proxy ranges

[Timer]
OnCalendar=daily
RandomizedDelaySec=1h
Persistent=true

[Install]
WantedBy=timers.target
REALIPTIMER

# Generate the file before nginx first starts, so no request is ever served with
# HAProxy as the rate-limit key.
/opt/app/update-realip.sh \
  || echo "realip bootstrap failed — rate limiting will key on HAProxy until the timer succeeds"

systemctl daemon-reload
systemctl enable --now update-realip.timer
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ctech-cdk && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add assets/ec2/setup-realip.sh test/ec2-scripts.test.ts
git commit -m "feat(ec2): add nginx realip refresh bootstrap script"
```

---

## Task 5: Shared nginx configuration script

**Files:**
- Create: `ctech-cdk/assets/ec2/setup-nginx.sh`
- Modify: `ctech-cdk/test/ec2-scripts.test.ts`

**Interfaces:**
- Consumes: `setup-realip.sh` must have run first, so `/etc/nginx/conf.d/realip.conf` exists.
- Produces: `setup-nginx.sh <nginx-port> <app-port> <health-path> [rate-per-second=100] [max-body=1m]`. The generated `http {}` block includes `/etc/nginx/conf.d/http-*.conf` and the generated `server {}` block includes `/etc/nginx/conf.d/location-*.conf`. Those two globs are the per-service extension points; `realip.conf` matches neither, so it is included exactly once.

- [ ] **Step 1: Write the failing test**

Append to `ctech-cdk/test/ec2-scripts.test.ts`:

```ts
test('setup-nginx.sh exposes both extension points and never double-includes realip', () => {
  const body = readFileSync(path.join(ASSETS_DIR, 'setup-nginx.sh'), 'utf8');
  assert.match(body, /include \/etc\/nginx\/conf\.d\/realip\*\.conf;/);
  assert.match(body, /include \/etc\/nginx\/conf\.d\/http-\*\.conf;/);
  assert.match(body, /include \/etc\/nginx\/conf\.d\/location-\*\.conf;/);
  assert.doesNotMatch(body, /include \/etc\/nginx\/conf\.d\/\*\.conf;/);
  assert.match(body, /proxy_set_header X-Forwarded-For \$remote_addr;/);
  assert.doesNotMatch(body, /proxy_add_x_forwarded_for/);
  assert.match(body, /nginx -t/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ctech-cdk && npm test`
Expected: FAIL — `ENOENT` reading `setup-nginx.sh`.

- [ ] **Step 3: Write the script**

Create `ctech-cdk/assets/ec2/setup-nginx.sh`:

```bash
#!/bin/bash
# The nginx configuration shared by every CTech service that fronts its Go binary
# with nginx (ctech-account, ctech-dfe, ctech-wallet, ctech-billing). ctech-poker
# is reached straight from HAProxy and does not call this script.
#
# Two extension points, because services differ in ways that do not belong here:
#   /etc/nginx/conf.d/http-*.conf      included inside http {}   (extra limit_req_zone, map)
#   /etc/nginx/conf.d/location-*.conf  included inside server {} (extra locations)
# realip.conf matches neither glob and is included on its own line, exactly once.
#
# Usage: setup-nginx.sh <nginx-port> <app-port> <health-path> [rate-per-second] [max-body]
#   setup-nginx.sh 8080 8000 /v1.0/health-check 20 5m
set -euo pipefail

NGINX_PORT="${1:?setup-nginx.sh: nginx listen port required}"
APP_PORT="${2:?setup-nginx.sh: app upstream port required}"
HEALTH_PATH="${3:?setup-nginx.sh: health check path required}"
RATE="${4:-100}"
MAX_BODY="${5:-1m}"

mkdir -p /etc/nginx/conf.d

# Quoted delimiter: nginx's own $variables must survive into the file unexpanded.
# The five values above are patched in with sed afterwards.
cat > /etc/nginx/nginx.conf << 'NGINX'
user nginx;
pid /run/nginx.pid;
worker_processes auto;
worker_rlimit_nofile 65535;
error_log /var/log/nginx/error.log warn;

events {
    worker_connections 8192;
    use epoll;
    multi_accept on;
}

http {
    include /etc/nginx/mime.types;
    default_type application/octet-stream;

    # Written by /opt/app/update-realip.sh: set_real_ip_from for HAProxy and for
    # CloudFront's origin-facing ranges, so $remote_addr below is the real viewer
    # IP and not the proxy's. The glob keeps nginx bootable if the file is absent.
    include /etc/nginx/conf.d/realip*.conf;

    log_format json_log escape=json '{"remote_addr":"$remote_addr","status":$status,"request":"$request","body_bytes_sent":$body_bytes_sent,"request_time":$request_time,"upstream_response_time":"$upstream_response_time"}';

    sendfile on;
    tcp_nopush on;
    tcp_nodelay on;
    keepalive_timeout 30;
    keepalive_requests 10000;
    reset_timedout_connection on;
    open_file_cache max=1000 inactive=20s;
    open_file_cache_valid 30s;
    open_file_cache_min_uses 2;
    open_file_cache_errors on;

    types_hash_max_size 2048;
    types_hash_bucket_size 128;

    client_header_timeout 15s;
    client_body_timeout 30s;
    send_timeout 30s;

    client_max_body_size __MAX_BODY__;
    client_body_buffer_size 128k;
    client_header_buffer_size 1k;
    large_client_header_buffers 4 8k;

    gzip on;
    gzip_vary on;
    gzip_proxied any;
    gzip_comp_level 5;
    gzip_min_length 1024;
    gzip_types application/json application/problem+json application/javascript text/plain text/css;

    server_tokens off;
    proxy_hide_header X-Powered-By;
    add_header X-Content-Type-Options nosniff always;
    add_header X-Frame-Options DENY always;
    add_header Referrer-Policy strict-origin-when-cross-origin always;

    # $binary_remote_addr is the viewer's IP, not HAProxy's, only because the
    # realip module rewrote it (see the include above). Without that the whole
    # req_by_ip zone collapses onto HAProxy's private IP and the rate becomes a
    # shared ceiling for every client at once.
    limit_req_zone $binary_remote_addr zone=req_by_ip:10m rate=__RATE__r/s;
    limit_conn_zone $binary_remote_addr zone=conn_by_ip:10m;
    limit_req_status  429;
    limit_conn_status 429;

    map $http_upgrade $connection_upgrade {
        default upgrade;
        ''      "";
    }

    # Per-service http-level additions (extra zones, maps).
    include /etc/nginx/conf.d/http-*.conf;

    upstream app {
        server 127.0.0.1:__APP_PORT__;
        keepalive 256;
        keepalive_requests 10000;
        keepalive_timeout 60s;
    }

    server {
        listen __NGINX_PORT__ default_server reuseport;
        server_name _;
        access_log /var/log/nginx/access.log json_log;
        error_log /var/log/nginx/error.log;

        # Per-service locations (WebSocket upgrades, per-tenant rate limits).
        # Included before `location /` so a more specific prefix can win.
        include /etc/nginx/conf.d/location-*.conf;

        location = __HEALTH_PATH__ {
            proxy_pass http://app;
            proxy_http_version 1.1;
            proxy_set_header Connection "";
            proxy_set_header Host $host;
            proxy_connect_timeout 5s;
            proxy_read_timeout 5s;
            access_log off;
        }

        location / {
            limit_req  zone=req_by_ip burst=200 nodelay;
            limit_conn conn_by_ip 100;

            proxy_pass http://app;
            proxy_http_version 1.1;
            proxy_set_header Connection "";
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            # Overwrite rather than append: $proxy_add_x_forwarded_for would carry
            # through whatever X-Forwarded-For the client sent, and the Go app
            # trusts the leftmost entry. $remote_addr is the realip-resolved
            # viewer IP, which a client cannot forge.
            proxy_set_header X-Forwarded-For $remote_addr;
            proxy_set_header X-Forwarded-Proto $http_x_forwarded_proto;
            proxy_connect_timeout 10s;
            proxy_send_timeout 60s;
            proxy_read_timeout 60s;
            proxy_buffering on;
            proxy_buffer_size 8k;
            proxy_buffers 16 16k;
            proxy_busy_buffers_size 32k;
        }
    }
}
NGINX

sed -i \
  -e "s|__NGINX_PORT__|${NGINX_PORT}|g" \
  -e "s|__APP_PORT__|${APP_PORT}|g" \
  -e "s|__HEALTH_PATH__|${HEALTH_PATH}|g" \
  -e "s|__RATE__|${RATE}|g" \
  -e "s|__MAX_BODY__|${MAX_BODY}|g" \
  /etc/nginx/nginx.conf

# Fail the boot here rather than serve a broken proxy: the ASG replacing the
# instance is a better outcome than one that passes EC2 health checks with no
# listener on the app port.
nginx -t

systemctl enable --now nginx
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ctech-cdk && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add assets/ec2/setup-nginx.sh test/ec2-scripts.test.ts
git commit -m "feat(ec2): add shared nginx bootstrap script with per-service extension points"
```

---

## Task 6: CloudWatch agent, systemd unit, and SSM environment scripts

**Files:**
- Create: `ctech-cdk/assets/ec2/setup-cloudwatch-agent.sh`
- Create: `ctech-cdk/assets/ec2/setup-app-service.sh`
- Create: `ctech-cdk/assets/ec2/setup-ssm-env.sh`
- Modify: `ctech-cdk/test/ec2-scripts.test.ts`

**Interfaces:**
- Consumes: `setup-base.sh` (for `/opt/app` and the `webapp` user) and `setup-dualstack.sh` (for the CloudWatch agent override).
- Produces:
  - `setup-cloudwatch-agent.sh <config-file>` — installs the file and runs `fetch-config`.
  - `setup-app-service.sh <description> <binary-name> [after-units]` — writes `/etc/systemd/system/app.service` and the generic `/opt/app/start.sh`. `start.sh` sources, in order: `/opt/app/current/release.env`, `/opt/app/load-ssm-env.sh`, `/opt/app/service-env.sh`, then `exec /opt/app/current/<binary-name>`.
  - `setup-ssm-env.sh VAR=/ssm/path …` — generates `/opt/app/load-ssm-env.sh`.
- `/opt/app/service-env.sh` is the per-service escape hatch: a service that must derive a value (ctech-wallet appending its Valkey DB number, ctech-poker deriving `TURNSTILE_EXPECTED_HOSTNAME`) writes that file from its own user data. It is optional; `start.sh` skips it when absent.

- [ ] **Step 1: Write the failing test**

Append to `ctech-cdk/test/ec2-scripts.test.ts`:

```ts
test('setup-ssm-env.sh rejects an argument that is not VAR=/path', () => {
  const body = readFileSync(path.join(ASSETS_DIR, 'setup-ssm-env.sh'), 'utf8');
  assert.match(body, /expected VAR=\/ssm\/path/);
  assert.match(body, /printf '%s=\$\(_ctech_ssm %q\)/, 'paths must be shell-quoted with %q');
});

test('setup-ssm-env.sh generates a loader read at service start, not at boot', () => {
  const body = readFileSync(path.join(ASSETS_DIR, 'setup-ssm-env.sh'), 'utf8');
  assert.match(body, /\/opt\/app\/load-ssm-env\.sh/);
  // The generated file must contain the aws call, not its result.
  assert.match(body, /aws ssm get-parameter/);
});

test('setup-app-service.sh sources the three env layers in order', () => {
  const body = readFileSync(path.join(ASSETS_DIR, 'setup-app-service.sh'), 'utf8');
  const release = body.indexOf('release.env');
  const ssmEnv = body.indexOf('load-ssm-env.sh');
  const serviceEnv = body.indexOf('service-env.sh');
  const exec = body.indexOf('exec /opt/app/current/');
  assert.ok(release > 0 && ssmEnv > release && serviceEnv > ssmEnv && exec > serviceEnv,
    'start.sh must source release.env, then load-ssm-env.sh, then service-env.sh, then exec');
  assert.match(body, /EnvironmentFile=\/etc\/app-static\.env/);
});

test('setup-cloudwatch-agent.sh requires a config file and runs fetch-config', () => {
  const body = readFileSync(path.join(ASSETS_DIR, 'setup-cloudwatch-agent.sh'), 'utf8');
  assert.match(body, /CONFIG="\$\{1:\?/);
  assert.match(body, /amazon-cloudwatch-agent-ctl -a fetch-config -m ec2/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ctech-cdk && npm test`
Expected: FAIL — `ENOENT` reading `setup-ssm-env.sh`.

- [ ] **Step 3: Write the scripts**

Create `ctech-cdk/assets/ec2/setup-cloudwatch-agent.sh`:

```bash
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
/opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl \
  -a fetch-config -m ec2 -c "file:$TARGET" -s
```

Create `ctech-cdk/assets/ec2/setup-app-service.sh`:

```bash
#!/bin/bash
# The systemd unit and the launcher every CTech Go service shares.
#
# start.sh layers configuration in increasing specificity:
#   1. /opt/app/current/release.env   APP_VERSION, shipped inside the artifact by CI
#   2. /opt/app/load-ssm-env.sh       generated by setup-ssm-env.sh, read on every start
#   3. /opt/app/service-env.sh        optional, written by the service's own user data
# Reading SSM at start rather than at boot is deliberate: an operator can change a
# parameter and `systemctl restart app` without a redeploy.
#
# Usage: setup-app-service.sh <description> <binary-name> [After= units]
#   setup-app-service.sh "CTech Wallet API" app "network.target nginx.service"
set -euo pipefail

DESCRIPTION="${1:?setup-app-service.sh: unit description required}"
BINARY="${2:?setup-app-service.sh: binary name required}"
AFTER="${3:-network.target}"

mkdir -p /opt/app

cat > /opt/app/start.sh << 'START'
#!/bin/bash
# Generated by setup-app-service.sh — do not edit. Per-service configuration
# belongs in /opt/app/service-env.sh.
if [ -f /opt/app/current/release.env ]; then set -a; . /opt/app/current/release.env; set +a; fi
if [ -f /opt/app/load-ssm-env.sh ]; then . /opt/app/load-ssm-env.sh; fi
if [ -f /opt/app/service-env.sh ]; then . /opt/app/service-env.sh; fi
exec /opt/app/current/__BINARY__
START

sed -i "s|__BINARY__|${BINARY}|g" /opt/app/start.sh
chmod 0755 /opt/app/start.sh

cat > /etc/systemd/system/app.service << SVC
[Unit]
Description=${DESCRIPTION}
After=${AFTER}
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
User=webapp
Group=webapp
WorkingDirectory=/opt/app/current
Environment=HOME=/opt/app
EnvironmentFile=/etc/app-static.env
ExecStartPre=/bin/test -x /opt/app/current/${BINARY}
ExecStart=/opt/app/start.sh
StandardOutput=append:/var/log/app/app.log
StandardError=append:/var/log/app/app.log
Restart=on-failure
RestartSec=30

[Install]
WantedBy=multi-user.target
SVC

systemctl daemon-reload
systemctl enable app
```

Create `ctech-cdk/assets/ec2/setup-ssm-env.sh`:

```bash
#!/bin/bash
# Generates /opt/app/load-ssm-env.sh from VAR=/ssm/path pairs.
#
# The generated file contains the aws calls, not their results: it is sourced by
# /opt/app/start.sh on every service start, so rotating a secret in SSM takes
# effect on `systemctl restart app` with no redeploy. Nothing secret ever reaches
# the launch template, which is readable by anyone holding
# ec2:DescribeLaunchTemplateVersions.
#
# Every read is best-effort: a parameter that does not exist yet leaves the
# variable empty rather than aborting the boot. Each consumer decides what an
# empty value means — a webhook secret that is empty must refuse to mount its
# route, while an absent cache URL may fall back to an in-memory backend.
#
# Usage: setup-ssm-env.sh VAR=/ssm/path [VAR=/ssm/path ...]
#   setup-ssm-env.sh CTECH_URL=/ctech-account/prod/internal-base-url \
#                    VALKEY_URL=/ctech/prod/valkey/url
set -euo pipefail

OUT=/opt/app/load-ssm-env.sh
mkdir -p /opt/app

[ "$#" -gt 0 ] || { echo "setup-ssm-env.sh: at least one VAR=/ssm/path pair required" >&2; exit 1; }

for pair in "$@"; do
  case "$pair" in
    *=/*) ;;
    *) echo "setup-ssm-env.sh: expected VAR=/ssm/path, got '$pair'" >&2; exit 1 ;;
  esac
done

{
  echo '#!/bin/bash'
  echo '# Generated by setup-ssm-env.sh — do not edit.'
  echo '# Sourced by /opt/app/start.sh on every service start.'
  echo 'AWS_REGION="${AWS_REGION:-us-east-1}"'
  echo '_ctech_ssm(){ aws ssm get-parameter --name "$1" --with-decryption --query Parameter.Value --output text --region "$AWS_REGION" 2>/dev/null || echo ""; }'
  for pair in "$@"; do
    name="${pair%%=*}"
    ssm_path="${pair#*=}"
    printf '%s=$(_ctech_ssm %q)\n' "$name" "$ssm_path"
    printf 'export %s\n' "$name"
  done
} > "$OUT"

chmod 0755 "$OUT"
chown webapp:webapp "$OUT"
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ctech-cdk && npm test`
Expected: PASS.

- [ ] **Step 5: Verify the generated loader by hand**

Run:

```bash
cd /tmp && mkdir -p opt/app && \
  bash -c 'OUT=/tmp/load-ssm-env.sh; set -- FOO=/a/b BAR=/c/d;
    { echo "#!/bin/bash"; for p in "$@"; do n=${p%%=*}; v=${p#*=}; printf "%s=\$(_ctech_ssm %q)\n" "$n" "$v"; done; } > $OUT; cat $OUT'
```

Expected output contains `FOO=$(_ctech_ssm /a/b)` and `BAR=$(_ctech_ssm /c/d)`.

- [ ] **Step 6: Commit**

```bash
git add assets/ec2/setup-cloudwatch-agent.sh assets/ec2/setup-app-service.sh assets/ec2/setup-ssm-env.sh test/ec2-scripts.test.ts
git commit -m "feat(ec2): add CloudWatch agent, systemd unit and SSM env bootstrap scripts"
```

---

## Task 7: Deploy, log shipping, and first-boot scripts

**Files:**
- Create: `ctech-cdk/assets/ec2/setup-deploy.sh`
- Create: `ctech-cdk/assets/ec2/setup-logs.sh`
- Create: `ctech-cdk/assets/ec2/bootstrap-deploy.sh`
- Modify: `ctech-cdk/test/ec2-scripts.test.ts`

**Interfaces:**
- Consumes: `setup-app-service.sh` (the `app` unit must exist before `deploy.sh` restarts it).
- Produces:
  - `setup-deploy.sh <deployments-bucket> <binary-name> <health-url>` — installs `/opt/app/deploy.sh`, whose own contract is unchanged: SSM RunCommand invokes `/opt/app/deploy.sh <s3-key>`.
  - `setup-logs.sh <logs-bucket> <s3-prefix> <service> <log-dir…>` — installs `/opt/app/upload-logs.sh` and `/etc/logrotate.d/<service>`.
  - `bootstrap-deploy.sh <deployments-bucket> <key>` — deploys `current.zip` on first boot when it exists.

- [ ] **Step 1: Write the failing test**

Append to `ctech-cdk/test/ec2-scripts.test.ts`:

```ts
test('setup-deploy.sh keeps the health-gated release swap', () => {
  const body = readFileSync(path.join(ASSETS_DIR, 'setup-deploy.sh'), 'utf8');
  assert.match(body, /ln -sfT "\$RELEASE_DIR" \/opt\/app\/current/);
  assert.match(body, /systemctl is-failed --quiet app/);
  assert.match(body, /journalctl -u app --no-pager/);
  assert.match(body, /tail -n \+2 \| xargs rm -rf/, 'must prune all but the live release');
});

test('setup-logs.sh never fails the logrotate run', () => {
  const body = readFileSync(path.join(ASSETS_DIR, 'setup-logs.sh'), 'utf8');
  assert.match(body, /X-aws-ec2-metadata-token-ttl-seconds/, 'IMDSv2 is enforced');
  assert.match(body, /\|\| exit 0/, 'every failure path must exit 0');
  assert.match(body, /postrotate/);
});

test('bootstrap-deploy.sh tolerates a missing first artifact', () => {
  const body = readFileSync(path.join(ASSETS_DIR, 'bootstrap-deploy.sh'), 'utf8');
  assert.match(body, /s3api head-object/);
  assert.match(body, /waiting for first deploy/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ctech-cdk && npm test`
Expected: FAIL — `ENOENT` reading `setup-deploy.sh`.

- [ ] **Step 3: Write the scripts**

Create `ctech-cdk/assets/ec2/setup-deploy.sh`:

```bash
#!/bin/bash
# Installs /opt/app/deploy.sh, which SSM RunCommand invokes from GitHub Actions
# with the release key as its only argument.
#
# Usage: setup-deploy.sh <deployments-bucket> <binary-name> <health-url>
#   setup-deploy.sh prod-ctech-deployments app http://127.0.0.1:8080/v1.0/health-check
set -euo pipefail

BUCKET="${1:?setup-deploy.sh: deployments bucket required}"
BINARY="${2:?setup-deploy.sh: binary name required}"
HEALTH_URL="${3:?setup-deploy.sh: health check URL required}"

mkdir -p /opt/app/releases

cat > /opt/app/deploy.sh << 'DEPLOY'
#!/bin/bash
# Generated by setup-deploy.sh — do not edit.
# Called by SSM RunCommand with the release key as $1. Expects a zip containing a
# pre-built binary for linux/arm64.
set -euo pipefail

S3_KEY="${1:?deploy.sh: S3 key required}"
RELEASE_DIR="/opt/app/releases/$(date +%Y%m%d_%H%M%S)"
mkdir -p "$RELEASE_DIR"

echo "Downloading release: $S3_KEY"
aws s3 cp "s3://__BUCKET__/$S3_KEY" /tmp/release.zip
unzip -o /tmp/release.zip -d "$RELEASE_DIR"
chmod +x "$RELEASE_DIR/__BINARY__"
chown -R webapp:webapp "$RELEASE_DIR"
ln -sfT "$RELEASE_DIR" /opt/app/current
systemctl restart app 2>/dev/null || systemctl start app

for _ in {1..60}; do
  if curl -sf "__HEALTH_URL__" >/dev/null; then
    echo "Health check passed"
    break
  fi
  if systemctl is-failed --quiet app; then
    echo "Application failed to start"
    journalctl -u app --no-pager -n 100 || true
    exit 1
  fi
  sleep 2
done

curl -sf "__HEALTH_URL__" >/dev/null || {
  echo "Timed out waiting for health check"
  exit 1
}

# Keep only the release that is live; the symlink already points at it.
ls -dt /opt/app/releases/*/ 2>/dev/null | tail -n +2 | xargs rm -rf 2>/dev/null || true
echo "Deployment successful"
DEPLOY

sed -i \
  -e "s|__BUCKET__|${BUCKET}|g" \
  -e "s|__BINARY__|${BINARY}|g" \
  -e "s|__HEALTH_URL__|${HEALTH_URL}|g" \
  /opt/app/deploy.sh

chmod 0755 /opt/app/deploy.sh
```

Create `ctech-cdk/assets/ec2/setup-logs.sh`:

```bash
#!/bin/bash
# Installs /opt/app/upload-logs.sh and the logrotate stanza that calls it.
#
# upload-logs.sh runs from logrotate's postrotate hook, so it must never fail the
# rotation: every step exits 0 on trouble.
#
# Usage: setup-logs.sh <logs-bucket> <s3-prefix> <service> <log-dir> [log-dir ...]
#   setup-logs.sh prod-ctech-application-logs ctech-wallet ctech-wallet /var/log/app /var/log/nginx
set -euo pipefail

LOGS_BUCKET="${1:?setup-logs.sh: logs bucket required}"
S3_PREFIX="${2:?setup-logs.sh: S3 prefix required}"
SERVICE="${3:?setup-logs.sh: service name required}"
shift 3
[ "$#" -gt 0 ] || { echo "setup-logs.sh: at least one log directory required" >&2; exit 1; }
LOG_DIRS="$*"

mkdir -p /opt/app

cat > /opt/app/upload-logs.sh << 'UPLOAD'
#!/bin/bash
# Generated by setup-logs.sh — do not edit.
# Bundles what logrotate just rotated and ships it to S3.
# IMDSv2 token required (requireImdsv2 is enforced on this instance).
TOKEN=$(curl -sf -X PUT "http://169.254.169.254/latest/api/token" \
    -H "X-aws-ec2-metadata-token-ttl-seconds: 60")
INSTANCE_ID=$(curl -sf -H "X-aws-ec2-metadata-token: $TOKEN" \
    "http://169.254.169.254/latest/meta-data/instance-id" || echo "unknown")

DATE=$(date +%Y%m%d)
ARCHIVE="/tmp/${DATE}-${INSTANCE_ID}.tar.gz"
ROTATED=$(find __LOG_DIRS__ -name "*-${DATE}.gz" 2>/dev/null)
[ -z "$ROTATED" ] && exit 0

tar czf "$ARCHIVE" $ROTATED 2>/dev/null || exit 0
aws s3 cp "$ARCHIVE" "s3://__LOGS_BUCKET__/__S3_PREFIX__/${DATE}-${INSTANCE_ID}.tar.gz" || exit 0
find __LOG_DIRS__ -name "*-${DATE}.gz" -delete
rm -f "$ARCHIVE"
UPLOAD

sed -i \
  -e "s|__LOG_DIRS__|${LOG_DIRS}|g" \
  -e "s|__LOGS_BUCKET__|${LOGS_BUCKET}|g" \
  -e "s|__S3_PREFIX__|${S3_PREFIX}|g" \
  /opt/app/upload-logs.sh

chmod 0755 /opt/app/upload-logs.sh

# One stanza covering every *.log under the directories we were given. logrotate
# accepts globs, so the list does not have to be enumerated file by file.
{
  for dir in $LOG_DIRS; do
    echo "${dir}/*.log"
  done
  cat << 'LOGROTATE'
{
    daily
    compress
    copytruncate
    missingok
    notifempty
    dateext
    dateformat -%Y%m%d
    rotate 1
    sharedscripts
    postrotate
        /opt/app/upload-logs.sh
    endscript
}
LOGROTATE
} > "/etc/logrotate.d/${SERVICE}"

chmod 0644 "/etc/logrotate.d/${SERVICE}"
```

Create `ctech-cdk/assets/ec2/bootstrap-deploy.sh`:

```bash
#!/bin/bash
# Deploys the current release on first boot if one has already been published.
# A brand-new environment has no artifact yet; that is not an error.
#
# Usage: bootstrap-deploy.sh <deployments-bucket> <key>
#   bootstrap-deploy.sh prod-ctech-deployments ctech-wallet/api/current.zip
set -euo pipefail

BUCKET="${1:?bootstrap-deploy.sh: deployments bucket required}"
KEY="${2:?bootstrap-deploy.sh: artifact key required}"

if aws s3api head-object --bucket "$BUCKET" --key "$KEY" >/dev/null 2>&1; then
  /opt/app/deploy.sh "$KEY"
else
  echo "No bootstrap artifact at s3://${BUCKET}/${KEY} — waiting for first deploy"
fi
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ctech-cdk && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add assets/ec2/setup-deploy.sh assets/ec2/setup-logs.sh assets/ec2/bootstrap-deploy.sh test/ec2-scripts.test.ts
git commit -m "feat(ec2): add deploy, log shipping and first-boot bootstrap scripts"
```

---

## Task 8: Ec2ScriptsStack and its SSM contract

**Files:**
- Modify: `ctech-cdk/lib/types.ts`
- Modify: `ctech-cdk/lib/constants.ts`
- Create: `ctech-cdk/lib/ec2-scripts-stack.ts`
- Modify: `ctech-cdk/bin/ctech-cdk.ts`
- Modify: `ctech-cdk/test/ec2-scripts.test.ts`

**Interfaces:**
- Consumes: every script from Tasks 1–7.
- Produces:
  - `SSM.ec2Scripts(env)` returning `{bucket: string, version: string}`.
  - `Ec2ScriptsStack`, whose constructor takes `{environment: Environment}` and exposes `public readonly bucketName: string` and `public readonly version: string`.
  - Deployed SSM parameters `/ctech/{env}/ec2-scripts/bucket` and `/ctech/{env}/ec2-scripts/version`.

**Note on lifecycle:** the bucket has **no expiration rule**. `prune: false` means old hash prefixes accumulate, but expiring objects by age would delete the *live* prefix on any environment whose scripts have not changed in that window, breaking every subsequent boot. The scripts total a few kilobytes; accumulation is not a cost problem worth that failure mode.

- [ ] **Step 1: Write the failing test**

Append to `ctech-cdk/test/ec2-scripts.test.ts`:

```ts
import * as cdk from 'aws-cdk-lib';
import {Match, Template} from 'aws-cdk-lib/assertions';
import {Ec2ScriptsStack} from '../lib/ec2-scripts-stack';
import {SSM} from '../lib';

test('SSM.ec2Scripts exposes the bucket and version paths', () => {
  assert.equal(SSM.ec2Scripts('prod').bucket, '/ctech/prod/ec2-scripts/bucket');
  assert.equal(SSM.ec2Scripts('prod').version, '/ctech/prod/ec2-scripts/version');
});

test('Ec2ScriptsStack publishes the scripts under a content-hash prefix', () => {
  const app = new cdk.App();
  const stack = new Ec2ScriptsStack(app, 'ScriptsFixture', {
    env: {account: '111111111111', region: 'us-east-1'},
    environment: 'prod',
  });
  const template = Template.fromStack(stack);

  template.hasResourceProperties('AWS::S3::Bucket', {
    BucketName: 'prod-ctech-ec2-scripts',
    VersioningConfiguration: {Status: 'Enabled'},
    PublicAccessBlockConfiguration: {
      BlockPublicAcls: true,
      BlockPublicPolicy: true,
      IgnorePublicAcls: true,
      RestrictPublicBuckets: true,
    },
  });

  // No expiration: an unchanged environment must not have its live prefix deleted.
  template.hasResource('AWS::S3::Bucket', {
    Properties: Match.objectLike({LifecycleConfiguration: Match.absent()}),
  });

  template.hasResourceProperties('Custom::CDKBucketDeployment', {
    DestinationBucketKeyPrefix: stack.version,
    Prune: false,
  });

  template.hasResourceProperties('AWS::SSM::Parameter', {
    Name: '/ctech/prod/ec2-scripts/version',
    Value: stack.version,
  });
  template.hasResourceProperties('AWS::SSM::Parameter', {
    Name: '/ctech/prod/ec2-scripts/bucket',
    Value: 'prod-ctech-ec2-scripts',
  });

  assert.match(stack.version, /^[0-9a-f]{64}$/, 'version must be the asset content hash');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ctech-cdk && npm test`
Expected: FAIL — `Cannot find module '../lib/ec2-scripts-stack'`.

- [ ] **Step 3: Add the SSM contract**

In `ctech-cdk/lib/types.ts`, add to the `SSMParams` interface, after the `s3` member:

```ts
  ec2Scripts: (env: Environment) => {
    bucket: string;
    version: string;
  };
```

In `ctech-cdk/lib/constants.ts`, add to the `SSM` object, after the `s3` member:

```ts
  // Written by Ec2ScriptsStack. `version` is the content hash of assets/ec2 and
  // is also the S3 key prefix the scripts live under. Consumers embed both in
  // user data at deploy time, which is what versions the launch template when a
  // script changes.
  ec2Scripts: (env: string) => ({
    bucket: `/ctech/${env}/ec2-scripts/bucket`,
    version: `/ctech/${env}/ec2-scripts/version`,
  }),
```

- [ ] **Step 4: Write the stack**

Create `ctech-cdk/lib/ec2-scripts-stack.ts`:

```ts
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3assets from 'aws-cdk-lib/aws-s3-assets';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import {Construct} from 'constructs';
import {SSM} from './constants';
import {Environment} from './types';

interface Ec2ScriptsStackProps extends cdk.StackProps {
  environment: Environment;
}

/**
 * Publishes the shared EC2 bootstrap scripts and records where they went.
 *
 * The S3 key prefix is the content hash of `assets/ec2`. Consumers read both SSM
 * parameters at synthesis, so the hash ends up literal inside the launch
 * template's user data: editing a script changes the hash, changes the user data,
 * versions the launch template, and triggers an instance refresh. A fixed key
 * would leave the user data byte-identical while the script changed underneath
 * running instances.
 *
 * `prune: false` keeps older prefixes alive for instances still booting from
 * them. There is deliberately no expiration rule — see the class comment in the
 * plan: expiring by age would delete the live prefix of any environment whose
 * scripts have not changed recently.
 */
export class Ec2ScriptsStack extends cdk.Stack {
  public readonly bucketName: string;
  /** Content hash of `assets/ec2`; also the S3 key prefix. */
  public readonly version: string;

  constructor(scope: Construct, id: string, props: Ec2ScriptsStackProps) {
    super(scope, id, props);

    const {environment} = props;

    const bucket = new s3.Bucket(this, 'ScriptsBucket', {
      bucketName: `${environment}-ctech-ec2-scripts`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const asset = new s3assets.Asset(this, 'ScriptsAsset', {
      path: path.join(__dirname, '..', 'assets', 'ec2'),
    });

    this.bucketName = bucket.bucketName;
    this.version = asset.assetHash;

    new s3deploy.BucketDeployment(this, 'PublishScripts', {
      sources: [s3deploy.Source.bucket(asset.bucket, asset.s3ObjectKey)],
      destinationBucket: bucket,
      destinationKeyPrefix: this.version,
      prune: false,
      retainOnDelete: true,
    });

    new ssm.StringParameter(this, 'ScriptsBucketParam', {
      parameterName: SSM.ec2Scripts(environment).bucket,
      stringValue: bucket.bucketName,
      description: 'Bucket holding the shared CTech EC2 bootstrap scripts',
    });

    new ssm.StringParameter(this, 'ScriptsVersionParam', {
      parameterName: SSM.ec2Scripts(environment).version,
      stringValue: this.version,
      description: 'Content hash and S3 key prefix of the current EC2 bootstrap scripts',
    });

    new cdk.CfnOutput(this, 'ScriptsBucketName', {
      value: this.bucketName,
      exportName: `${id}-scripts-bucket`,
    });
    new cdk.CfnOutput(this, 'ScriptsVersion', {
      value: this.version,
      exportName: `${id}-scripts-version`,
    });
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd ctech-cdk && npm test`
Expected: PASS.

- [ ] **Step 6: Wire the stack into the app**

In `ctech-cdk/bin/ctech-cdk.ts`, add the import next to the other stack imports:

```ts
import {Ec2ScriptsStack} from '../lib/ec2-scripts-stack';
```

and instantiate it after the `S3Stack` block:

```ts
// =====================
// Shared EC2 bootstrap scripts (consumed by every service CDK and by the
// Terraform services through /ctech/{env}/ec2-scripts/* SSM parameters).
// =====================
new Ec2ScriptsStack(app, `Ctech-${cap(ENVIRONMENT)}-Ec2Scripts`, {
  env,
  environment: ENVIRONMENT,
  description: `CTech Shared EC2 Bootstrap Scripts - ${ENVIRONMENT}`,
});
```

- [ ] **Step 7: Verify synthesis**

Run: `cd ctech-cdk && npx tsc --noEmit && npx cdk synth Ctech-Dev-Ec2Scripts`
Expected: a template containing the bucket, the `Custom::CDKBucketDeployment` resource, and both SSM parameters.

- [ ] **Step 8: Commit**

```bash
git add lib/types.ts lib/constants.ts lib/ec2-scripts-stack.ts bin/ctech-cdk.ts test/ec2-scripts.test.ts
git commit -m "feat(ec2): publish shared bootstrap scripts from a hash-prefixed S3 stack"
```

---

## Task 9: Ec2ScriptRunner

**Files:**
- Create: `ctech-cdk/lib/ec2-script-runner.ts`
- Modify: `ctech-cdk/lib/index.ts`
- Modify: `ctech-cdk/lib/cloudwatch-agent-config.ts:120`
- Modify: `ctech-cdk/test/ec2-scripts.test.ts`
- Modify: `ctech-cdk/test/shared-components.test.ts`

**Interfaces:**
- Consumes: `SSM.ec2Scripts(env)` from Task 8.
- Produces, exported from `@aoctech/cdk`:
  - `Ec2ScriptRunnerProps { environment: Environment }`
  - `class Ec2ScriptRunner extends Construct`
    - `install(userData: ec2.UserData): void`
    - `run(userData: ec2.UserData, script: string, ...args: string[]): void`
    - `grantRead(grantee: iam.IGrantable): void`
    - `readonly bucketName: string`
    - `readonly version: string`

`buildCloudWatchAgentConfig` switches from `JSON.stringify(…, null, 2)` to compact output. This is a deliberate user-data change for every service (roughly 40% smaller) and will version their launch templates on next deploy.

- [ ] **Step 1: Write the failing test**

Append to `ctech-cdk/test/ec2-scripts.test.ts`:

```ts
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import {Ec2ScriptRunner} from '../lib';

test('Ec2ScriptRunner emits a download-then-execute prelude, never a pipe to bash', () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, 'RunnerFixture', {
    env: {account: '111111111111', region: 'us-east-1'},
  });
  const runner = new Ec2ScriptRunner(stack, 'Scripts', {environment: 'prod'});
  const userData = ec2.UserData.forLinux();
  runner.install(userData);
  runner.run(userData, 'setup-swap.sh', '256');

  const rendered = userData.render();
  assert.match(rendered, /ctech_run\(\)/);
  assert.match(rendered, /aws s3 cp/);
  assert.doesNotMatch(rendered, /aws s3 cp [^\n]*\| *bash/);
  assert.match(rendered, /ctech_run setup-swap\.sh '256'/);
});

test('Ec2ScriptRunner shell-quotes arguments', () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, 'QuoteFixture', {
    env: {account: '111111111111', region: 'us-east-1'},
  });
  const runner = new Ec2ScriptRunner(stack, 'Scripts', {environment: 'dev'});
  const userData = ec2.UserData.forLinux();
  runner.run(userData, 'setup-ssm-env.sh', "FOO=/a/b'c");

  assert.match(userData.render(), /'FOO=\/a\/b'\\''c'/);
});

test('Ec2ScriptRunner rejects a script name that is not a bare filename', () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, 'RejectFixture');
  const runner = new Ec2ScriptRunner(stack, 'Scripts', {environment: 'dev'});
  assert.throws(
    () => runner.run(ec2.UserData.forLinux(), '../../etc/passwd'),
    /must be a bare script filename/,
  );
});
```

Append to `ctech-cdk/test/shared-components.test.ts`:

```ts
test('buildCloudWatchAgentConfig emits compact JSON to conserve user data', () => {
  const config = buildCloudWatchAgentConfig({
    metricNamespace: 'CtechExample/prod/Host',
    logFiles: [{
      filePath: '/var/log/app/app.log',
      logGroupName: '/ctech-example/prod/app',
      logStreamName: '{instance_id}',
    }],
  });
  assert.doesNotMatch(config, /\n/, 'config must be a single line');
  assert.ok(JSON.parse(config));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ctech-cdk && npm test`
Expected: FAIL — `Ec2ScriptRunner` is not exported, and the compact-JSON assertion fails on the pretty-printed output.

- [ ] **Step 3: Write the runner**

Create `ctech-cdk/lib/ec2-script-runner.ts`:

```ts
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import {Construct} from 'constructs';
import {SSM} from './constants';
import {Environment} from './types';

export interface Ec2ScriptRunnerProps {
  environment: Environment;
}

/** Single-quote for POSIX sh: wrap, and close-escape-reopen each embedded quote. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Emits user data that fetches the shared bootstrap scripts from S3 and runs
 * them, instead of writing their contents inline.
 *
 * Both SSM parameters are read with `valueForStringParameter`, so CloudFormation
 * resolves them at deploy time and the bucket name and content hash are literal
 * text in the launch template. That is the whole point: a script edit changes the
 * hash, which changes the user data, which versions the launch template and
 * triggers an instance refresh.
 *
 * Scripts are downloaded to a file and then executed rather than piped into
 * `bash`. A pipe truncated mid-transfer runs a partial script and reports
 * success; `aws s3 cp` under `set -e` fails the boot instead.
 */
export class Ec2ScriptRunner extends Construct {
  public readonly bucketName: string;
  public readonly version: string;

  constructor(scope: Construct, id: string, props: Ec2ScriptRunnerProps) {
    super(scope, id);

    this.bucketName = ssm.StringParameter.valueForStringParameter(
      this, SSM.ec2Scripts(props.environment).bucket,
    );
    this.version = ssm.StringParameter.valueForStringParameter(
      this, SSM.ec2Scripts(props.environment).version,
    );
  }

  /** Emits the `ctech_run` helper. Call once, before any `run`. */
  public install(userData: ec2.UserData): void {
    userData.addCommands(
      `CTECH_SCRIPTS="s3://${this.bucketName}/${this.version}"`,
      'ctech_run(){ s="$1"; shift; aws s3 cp "$CTECH_SCRIPTS/$s" "/tmp/$s" >/dev/null; bash "/tmp/$s" "$@"; }',
    );
  }

  /** Appends one script invocation with shell-quoted arguments. */
  public run(userData: ec2.UserData, script: string, ...args: string[]): void {
    if (!/^[a-z0-9][a-z0-9._-]*\.sh$/.test(script)) {
      throw new Error(`Ec2ScriptRunner: "${script}" must be a bare script filename ending in .sh`);
    }
    const quoted = args.map(shellQuote).join(' ');
    userData.addCommands(`ctech_run ${script}${quoted ? ` ${quoted}` : ''}`);
  }

  /** Grants an instance role permission to download the scripts. */
  public grantRead(grantee: iam.IGrantable): void {
    grantee.grantPrincipal.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['s3:GetObject'],
      resources: [`arn:aws:s3:::${this.bucketName}/*`],
    }));
  }
}
```

- [ ] **Step 4: Export it and compact the CloudWatch config**

In `ctech-cdk/lib/index.ts`, add:

```ts
export {Ec2ScriptRunner, Ec2ScriptRunnerProps} from './ec2-script-runner';
```

In `ctech-cdk/lib/cloudwatch-agent-config.ts`, change the final `return JSON.stringify({…}, null, 2);` to `return JSON.stringify({…});` — remove only the two trailing arguments. Add above the return:

```ts
  // Compact rather than pretty-printed: this string is embedded verbatim in EC2
  // user data, which is capped at 16 KB.
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd ctech-cdk && npm test && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/ec2-script-runner.ts lib/index.ts lib/cloudwatch-agent-config.ts test/ec2-scripts.test.ts test/shared-components.test.ts
git commit -m "feat(ec2): add Ec2ScriptRunner and compact the CloudWatch agent config"
```

---

## Task 10: Scheduled ASG enable/disable

**Files:**
- Modify: `ctech-cdk/lib/haproxy-ec2-service.ts`
- Modify: `ctech-cdk/lib/valkey-stack.ts:279-297`
- Modify: `ctech-cdk/test/shared-components.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces, exported from `@aoctech/cdk`:

```ts
export interface AsgScheduleProps {
  /** UNIX cron, 5 fields. Default '0 22 * * *'. Scales min/max/desired to 0. */
  disableCron?: string;
  /** UNIX cron, 5 fields. Default '0 10 * * *'. Restores configured capacity. */
  enableCron?: string;
  /** IANA zone. Default 'America/Sao_Paulo'. */
  timeZone?: string;
}
```

`HaproxyEc2ServiceProps` gains `schedule?: AsgScheduleProps`. `ValkeyStackProps` gains the same.

**Why this replaces the uncommitted block:** `lib/valkey-stack.ts:279-297` currently registers `DefaultDisable` and `DefaultEnable` with the same `0 1 * * *` cron and sets `minCapacity`, `maxCapacity` and `desiredCapacity` to 0 on both. The pair only ever scales down, and with no `timeZone` the cron is interpreted as UTC rather than BRT.

**Operational consequence, accepted in the spec:** this applies to production. Every service and the shared Valkey are down 22:00–10:00 BRT daily (01:00–13:00 UTC); inbound webhooks and scheduled jobs fail in that window.

- [ ] **Step 1: Write the failing test**

Append to `ctech-cdk/test/shared-components.test.ts`:

```ts
import * as ssm from 'aws-cdk-lib/aws-ssm';

test('HaproxyEc2Service schedules disable to zero and enable back to configured capacity', () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, 'ScheduleFixture', {
    env: {account: '111111111111', region: 'us-east-1'},
  });
  const vpc = new ec2.Vpc(stack, 'Vpc');
  new HaproxyEc2Service(stack, 'Svc', {
    vpc,
    edgeSecurityGroup: new ec2.SecurityGroup(stack, 'Edge', {vpc}),
    appPort: 8080,
    userData: ec2.UserData.forLinux(),
    instanceProfileName: 'fixture-profile',
    securityGroupName: 'fixture-sg',
    securityGroupDescription: 'fixture',
    appLogGroupName: '/fixture/app',
    logRetention: logs.RetentionDays.ONE_WEEK,
    logRemovalPolicy: cdk.RemovalPolicy.DESTROY,
    asgName: 'fixture-asg',
    minCapacity: 1,
    maxCapacity: 3,
    schedule: {},
  });
  const template = Template.fromStack(stack);

  template.hasResourceProperties('AWS::AutoScaling::ScheduledAction', {
    Recurrence: '0 22 * * *',
    TimeZone: 'America/Sao_Paulo',
    MinSize: 0,
    MaxSize: 0,
    DesiredCapacity: 0,
  });
  template.hasResourceProperties('AWS::AutoScaling::ScheduledAction', {
    Recurrence: '0 10 * * *',
    TimeZone: 'America/Sao_Paulo',
    MinSize: 1,
    MaxSize: 3,
    DesiredCapacity: 1,
  });
});

test('HaproxyEc2Service registers no scheduled action when schedule is omitted', () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, 'NoScheduleFixture', {
    env: {account: '111111111111', region: 'us-east-1'},
  });
  const vpc = new ec2.Vpc(stack, 'Vpc');
  new HaproxyEc2Service(stack, 'Svc', {
    vpc,
    edgeSecurityGroup: new ec2.SecurityGroup(stack, 'Edge', {vpc}),
    appPort: 8080,
    userData: ec2.UserData.forLinux(),
    instanceProfileName: 'fixture-profile',
    securityGroupName: 'fixture-sg',
    securityGroupDescription: 'fixture',
    appLogGroupName: '/fixture/app',
    logRetention: logs.RetentionDays.ONE_WEEK,
    logRemovalPolicy: cdk.RemovalPolicy.DESTROY,
    asgName: 'fixture-asg',
    minCapacity: 1,
    maxCapacity: 1,
  });
  Template.fromStack(stack).resourceCountIs('AWS::AutoScaling::ScheduledAction', 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ctech-cdk && npm test`
Expected: FAIL — `schedule` is not a known property of `HaproxyEc2ServiceProps`.

- [ ] **Step 3: Add the shared props and helper**

In `ctech-cdk/lib/haproxy-ec2-service.ts`, add above `HaproxyEc2ServiceProps`:

```ts
export interface AsgScheduleProps {
  /** UNIX cron, 5 fields. Default '0 22 * * *'. */
  disableCron?: string;
  /** UNIX cron, 5 fields. Default '0 10 * * *'. */
  enableCron?: string;
  /** IANA time zone. Default 'America/Sao_Paulo' — AWS defaults to UTC. */
  timeZone?: string;
}

export const DEFAULT_ASG_SCHEDULE = {
  disableCron: '0 22 * * *',
  enableCron: '0 10 * * *',
  timeZone: 'America/Sao_Paulo',
} as const;

/**
 * Registers the nightly stop/start pair.
 *
 * `enable` restores the capacity the ASG was configured with; a scheduled action
 * that leaves min/max at 0 is a one-way switch, not a schedule.
 */
export function addAsgSchedule(
  asg: autoscaling.AutoScalingGroup,
  capacity: {minCapacity: number; maxCapacity: number; desiredCapacity?: number},
  schedule: AsgScheduleProps,
): void {
  const timeZone = schedule.timeZone ?? DEFAULT_ASG_SCHEDULE.timeZone;

  asg.scaleOnSchedule('ScheduledDisable', {
    schedule: autoscaling.Schedule.expression(schedule.disableCron ?? DEFAULT_ASG_SCHEDULE.disableCron),
    timeZone,
    minCapacity: 0,
    maxCapacity: 0,
    desiredCapacity: 0,
  });

  asg.scaleOnSchedule('ScheduledEnable', {
    schedule: autoscaling.Schedule.expression(schedule.enableCron ?? DEFAULT_ASG_SCHEDULE.enableCron),
    timeZone,
    minCapacity: capacity.minCapacity,
    maxCapacity: capacity.maxCapacity,
    desiredCapacity: capacity.desiredCapacity ?? capacity.minCapacity,
  });
}
```

Add `schedule?: AsgScheduleProps;` to `HaproxyEc2ServiceProps`, and in the constructor, immediately after the `scaleOnCpuUtilization` block:

```ts
    if (props.schedule) {
      addAsgSchedule(this.autoScalingGroup, props, props.schedule);
    }
```

- [ ] **Step 4: Replace the no-op block in ValkeyStack**

In `ctech-cdk/lib/valkey-stack.ts`, delete the `import {Schedule} from 'aws-cdk-lib/aws-autoscaling';` line added at the top, and delete the entire `asg.scaleOnSchedule('DefaultDisable', …)` / `asg.scaleOnSchedule('DefaultEnable', …)` block at lines 279-297. Replace it with:

```ts
    // Nightly stop/start. Applied to every environment, production included:
    // treat the cache as unavailable in the window, exactly as when the ASG is
    // being replaced. prod's minCapacity is 1, so enable restores one instance.
    if (props.schedule) {
      addAsgSchedule(asg, {minCapacity: isProd ? 1 : 0, maxCapacity: 1}, props.schedule);
    }
```

Add to the imports:

```ts
import {addAsgSchedule, AsgScheduleProps} from './haproxy-ec2-service';
```

and to `ValkeyStackProps`:

```ts
  schedule?: AsgScheduleProps;
```

In `ctech-cdk/bin/ctech-cdk.ts`, pass `schedule: {}` to the `ValkeyStack` instantiation to opt in with the defaults.

- [ ] **Step 5: Export the new symbols**

In `ctech-cdk/lib/index.ts`, extend the existing `haproxy-ec2-service` export:

```ts
export {
  HaproxyEc2Service,
  HaproxyEc2ServiceProps,
  HaproxyRouteRegistrationProps,
  AsgScheduleProps,
  DEFAULT_ASG_SCHEDULE,
  addAsgSchedule,
} from './haproxy-ec2-service';
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd ctech-cdk && npm test && npx tsc --noEmit && npx cdk synth Ctech-Dev-Valkey`
Expected: PASS, and the Valkey template contains two `AWS::AutoScaling::ScheduledAction` resources with different `Recurrence` values.

- [ ] **Step 7: Commit**

```bash
git add lib/haproxy-ec2-service.ts lib/valkey-stack.ts lib/index.ts bin/ctech-cdk.ts test/shared-components.test.ts
git commit -m "feat(asg): add nightly scheduled enable/disable to shared ASG constructs"
```

---

## Task 11: Documentation and package release

**Files:**
- Modify: `ctech-cdk/README.md`
- Modify: `ctech-cdk/CLAUDE.md`
- Modify: `ctech-cdk/package.json`

**Interfaces:**
- Consumes: everything from Tasks 1–10.
- Produces: `@aoctech/cdk` 0.3.0.

- [ ] **Step 1: Document the SSM contract in README.md**

Under `## SSM parameters written by deployed stacks`, add:

```markdown
| `/ctech/{env}/ec2-scripts/bucket` | `Ec2ScriptsStack` | Bucket holding the shared EC2 bootstrap scripts |
| `/ctech/{env}/ec2-scripts/version` | `Ec2ScriptsStack` | Content hash of `assets/ec2`, and the S3 key prefix the scripts live under |
```

- [ ] **Step 2: Document the consumption pattern in README.md**

Under `## Adding a service`, add a subsection:

````markdown
### Bootstrapping an instance

User data is a list of script invocations, not a list of files. Compose it with
`Ec2ScriptRunner`:

```ts
const scripts = new Ec2ScriptRunner(this, 'Scripts', {environment});
scripts.install(userData);
scripts.run(userData, 'setup-base.sh', 'ctech-example', 'nginx');
scripts.run(userData, 'setup-swap.sh', '256');
scripts.run(userData, 'setup-dualstack.sh');
scripts.run(userData, 'setup-cloudflare-ca.sh');
scripts.run(userData, 'setup-realip.sh', vpc.vpcCidrBlock);
scripts.run(userData, 'setup-nginx.sh', '8080', '8000', '/v1.0/health-check');
```

The instance role needs `s3:GetObject` on the scripts bucket:
`scripts.grantRead(role)`.

Only values CloudFormation has to resolve stay inline: bucket names, log group
names, the CloudWatch agent JSON, and `/etc/app-static.env`. Per-service nginx
locations go in `/etc/nginx/conf.d/location-*.conf`; per-service derived
environment variables go in `/opt/app/service-env.sh`.

The scripts themselves live in `assets/ec2/` in this repository. Editing one
changes the asset hash, which changes every consuming service's user data on its
next deploy — that is what triggers the instance refresh, and it means a script
change is a cross-repository change.
````

- [ ] **Step 3: Update CLAUDE.md**

Under `## Source of truth`, add `Ec2ScriptsStack` to the list of stacks `bin/ctech-cdk.ts` instantiates:

```markdown
- `Ec2ScriptsStack`: shared EC2 bootstrap scripts published under a content-hash
  prefix, with `/ctech/{env}/ec2-scripts/{bucket,version}` pointers.
```

Under `## Published package`, add to the current public exports list:

```markdown
- `Ec2ScriptRunner` and props;
- `AsgScheduleProps`, `DEFAULT_ASG_SCHEDULE`, `addAsgSchedule`;
```

and add a paragraph:

```markdown
Shared EC2 user-data fragments (`addSwapCommands` and the rest) are superseded by
`assets/ec2/*.sh` plus `Ec2ScriptRunner`. They remain exported until every
service repository has migrated, then are removed in 1.0.0 alongside
`PrivateIpv4Ec2Service`. Do not add new consumers.
```

- [ ] **Step 4: Bump the version**

In `ctech-cdk/package.json`, change `"version": "0.2.1"` to `"version": "0.3.0"`.

- [ ] **Step 5: Verify the whole repository**

Run: `cd ctech-cdk && npm test && npx tsc --noEmit && npx cdk synth`
Expected: PASS, and every stack synthesises.

- [ ] **Step 6: Commit**

```bash
git add README.md CLAUDE.md package.json
git commit -m "docs(ec2): document the shared bootstrap script contract and release 0.3.0"
```

- [ ] **Step 7: Deploy Ec2ScriptsStack before any service migrates**

Run, per environment, in order `dev`, `stage`, `prod`:

```bash
ENVIRONMENT=dev npx cdk deploy Ctech-Dev-Ec2Scripts
aws ssm get-parameter --name /ctech/dev/ec2-scripts/version --query Parameter.Value --output text
aws s3 ls "s3://dev-ctech-ec2-scripts/$(aws ssm get-parameter --name /ctech/dev/ec2-scripts/version --query Parameter.Value --output text)/"
```

Expected: twelve `.sh` objects under the hash prefix. No service can migrate until this parameter exists in its environment.

---

## Task 12: Migrate ctech-dfe

Smallest diff and already asset-based, so it proves the contract before the riskier services.

**Files:**
- Modify: `ctech-dfe/cdk/lib/api-stack.ts:96-232`
- Modify: `ctech-dfe/cdk/lib/iam-stack.ts`
- Delete: `ctech-dfe/cdk/scripts/api/setup.sh`, `start.sh`, `deploy.sh`, `upload-logs.sh`, `logrotate.conf`, `app.service`
- Modify: `ctech-dfe/cdk/scripts/api/nginx.conf` → becomes `ctech-dfe/cdk/scripts/api/http-dfe.conf` and `location-dfe.conf`
- Modify: `ctech-dfe/cdk/test/api-stack.test.ts`
- Modify: `ctech-dfe/cdk/package.json` (`@aoctech/cdk` to `^0.3.0`)

**Interfaces:**
- Consumes: `Ec2ScriptRunner`, every script from Tasks 1–7, and the deployed `/ctech/{env}/ec2-scripts/*` parameters.
- Produces: nothing other repositories depend on.

- [ ] **Step 1: Produce the nginx diff**

The shared `setup-nginx.sh` must not silently drop a directive ctech-dfe relies on. Render the shared config locally and diff it against the current one:

```bash
cd ctech-dfe/cdk
bash ../../ctech-cdk/assets/ec2/setup-nginx.sh 8080 8000 /v1.0/health-check 100 1m 2>/dev/null || true
# setup-nginx.sh writes /etc/nginx/nginx.conf and runs `nginx -t`; on a dev box
# without root, extract the heredoc instead:
sed -n "/^cat > \/etc\/nginx\/nginx.conf << 'NGINX'$/,/^NGINX$/p" \
  ../../ctech-cdk/assets/ec2/setup-nginx.sh | sed '1d;$d' > /tmp/shared-nginx.conf
diff -u /tmp/shared-nginx.conf scripts/api/nginx.conf
```

Every line the diff shows as present only in `scripts/api/nginx.conf` must land in one of two files, or be consciously dropped:
- directives valid inside `http {}` (extra `limit_req_zone`, `map`) → `scripts/api/http-dfe.conf`
- directives valid inside `server {}` (extra `location` blocks) → `scripts/api/location-dfe.conf`

Record in the commit message anything the diff shows that you decided to drop.

- [ ] **Step 2: Write the failing test**

In `ctech-dfe/cdk/test/api-stack.test.ts`, replace the assertions that inspect inline user data with:

```ts
test('api user data only fetches and runs shared scripts', () => {
  const template = Template.fromStack(apiStack);
  const [launchTemplate] = Object.values(
    template.findResources('AWS::EC2::LaunchTemplate'),
  ) as any[];
  const userData = JSON.stringify(launchTemplate.Properties.LaunchTemplateData.UserData);

  assert.match(userData, /ctech_run/);
  assert.match(userData, /setup-base.sh/);
  assert.match(userData, /setup-nginx.sh/);
  // Nothing may be written inline any more except the two env files and the
  // CloudWatch agent config.
  const heredocs = userData.match(/cat > /g) ?? [];
  assert.ok(heredocs.length <= 4, `expected at most 4 inline heredocs, found ${heredocs.length}`);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd ctech-dfe/cdk && npm test`
Expected: FAIL — the rendered user data still contains the old `unzip -o /tmp/api-bootstrap.zip` block and many heredocs.

- [ ] **Step 4: Replace the user data**

In `ctech-dfe/cdk/lib/api-stack.ts`, remove the `s3assets` import, the `ApiBootstrap` asset, the `addSwapCommands`/`addDualStackSsmAgentCommands`/`addCloudflareOriginCaCommands`/`addRealipRefreshCommands`/`addCloudWatchAgentDualStackOverride` imports and calls, and the `/opt/bootstrap` download block. Replace the whole user-data section with:

```ts
    const scripts = new Ec2ScriptRunner(this, 'Scripts', {environment});
    const userData = ec2.UserData.forLinux();
    scripts.install(userData);

    scripts.run(userData, 'setup-base.sh', svcName, 'nginx');
    scripts.run(userData, 'setup-swap.sh', '256');
    scripts.run(userData, 'setup-dualstack.sh');
    scripts.run(userData, 'setup-cloudflare-ca.sh');

    // /etc/app-static.env: non-secret values systemd loads via EnvironmentFile.
    // CDK tokens are substituted at synthesis; bash does not expand them.
    userData.addCommands(
      `cat > /etc/app-static.env << 'ENV'`,
      `ENVIRONMENT=${environment}`,
      `TABLE_PREFIX=${environment}_dfe`,
      `AWS_REGION=${this.region}`,
      `AWS_USE_DUALSTACK_ENDPOINT=true`,
      `S3_BUCKET_CERTIFICATES=${certificatesBucketName}`,
      `S3_BUCKET_DOCUMENTS=${documentsBucketName}`,
      `DFE_TOPIC_ARN=${nfeEmissionTopicArn}`,
      `DFE_RESULTS_QUEUE_URL=${resultsQueueUrl}`,
      `DFE_DISTRIBUTION_QUEUE_URL=${distributionQueueUrl}`,
      `SEFAZ_FUNCTION_NAME=${environment}-py-dfe`,
      `TRUSTED_PROXIES=127.0.0.1`,
      `ENV`,
    );

    // Secrets are read by name at service start, never embedded: the launch
    // template is readable by anyone holding ec2:DescribeLaunchTemplateVersions.
    scripts.run(userData, 'setup-ssm-env.sh',
      `VALKEY_URL=${valkeyUrlSsmPath}`,
      `CTECH_JWKS_URL=${accountInternalJwksUrlParameter}`,
      `CTECH_URL=${accountInternalBaseUrlParameter}`,
      `CTECH_ISSUER_URL=${accountIssuerUrlParameter}`,
      `SERVICE_AUDIENCE=${appUrlParameter}`,
      `BILLING_WEBHOOK_SECRET=${billingWebhookSecretParameter}`,
      `BILLING_API_URL=${billingBaseUrlParameter}`,
      `BILLING_CLIENT_ID=${billingClientIdParameter}`,
      `BILLING_CLIENT_SECRET=${billingClientSecretParameter}`,
    );

    // CORS_ALLOWED_ORIGINS is derived, not fetched — the escape hatch start.sh
    // sources after load-ssm-env.sh.
    userData.addCommands(
      `cat > /opt/app/service-env.sh << 'SERVICEENV'`,
      `CORS_ALLOWED_ORIGINS="$SERVICE_AUDIENCE"`,
      `export CORS_ALLOWED_ORIGINS`,
      `SERVICEENV`,
      `chmod 0755 /opt/app/service-env.sh`,
    );

    // Per-service nginx additions, installed before setup-nginx.sh runs `nginx -t`.
    userData.addCommands(
      `cat > /etc/nginx/conf.d/http-dfe.conf << 'HTTPDFE'`,
      ...readFileSync(path.join(__dirname, '..', 'scripts', 'api', 'http-dfe.conf'), 'utf8').split('\n'),
      `HTTPDFE`,
      `cat > /etc/nginx/conf.d/location-dfe.conf << 'LOCDFE'`,
      ...readFileSync(path.join(__dirname, '..', 'scripts', 'api', 'location-dfe.conf'), 'utf8').split('\n'),
      `LOCDFE`,
    );

    scripts.run(userData, 'setup-realip.sh', vpc.vpcCidrBlock);
    scripts.run(userData, 'setup-nginx.sh', '8080', '8000', '/v1.0/health-check');
    scripts.run(userData, 'setup-app-service.sh', 'CTech DFe API', 'app', 'network.target nginx.service');
    scripts.run(userData, 'setup-deploy.sh', deploymentsBucketName, 'app',
      'http://127.0.0.1:8080/v1.0/health-check');
    scripts.run(userData, 'setup-logs.sh', logsBucketName, svcName, svcName,
      '/var/log/app', '/var/log/nginx');

    userData.addCommands(
      `cat > /tmp/cwagent.json << 'CWA'`,
      buildCloudWatchAgentConfig({
        metricNamespace: `CtechDfe/${environment}/Host`,
        appProcessPattern: '/opt/app/current/(app|bootstrap)',
        logFiles: [
          {filePath: '/var/log/app/app.log', logGroupName: logGroupApp, logStreamName: '{instance_id}'},
          {filePath: '/var/log/nginx/access.log', logGroupName: logGroupNginx, logStreamName: '{instance_id}/access'},
          {filePath: '/var/log/nginx/error.log', logGroupName: logGroupNginx, logStreamName: '{instance_id}/error'},
        ],
      }),
      `CWA`,
    );
    scripts.run(userData, 'setup-cloudwatch-agent.sh', '/tmp/cwagent.json');
    scripts.run(userData, 'bootstrap-deploy.sh', deploymentsBucketName, 'ctech-dfe/api/current.zip');
```

Add at the top of the file:

```ts
import {readFileSync} from 'node:fs';
import {buildCloudWatchAgentConfig, Ec2ScriptRunner, HaproxyEc2Service} from '@aoctech/cdk';
```

`/etc/bootstrap.env` disappears: `setup-ssm-env.sh` receives the parameter names as arguments, and `AWS_REGION` reaches `load-ssm-env.sh` through `/etc/app-static.env`.

- [ ] **Step 5: Grant the instance role access to the scripts bucket**

In `ctech-dfe/cdk/lib/iam-stack.ts`, add to the instance role's policy:

```ts
    instanceRole.addToPolicy(new iam.PolicyStatement({
      sid: 'ReadSharedEc2BootstrapScripts',
      actions: ['s3:GetObject'],
      resources: [`arn:aws:s3:::${environment}-ctech-ec2-scripts/*`],
    }));
```

- [ ] **Step 6: Delete the superseded assets**

```bash
cd ctech-dfe/cdk
git rm scripts/api/setup.sh scripts/api/start.sh scripts/api/deploy.sh \
       scripts/api/upload-logs.sh scripts/api/logrotate.conf scripts/api/app.service \
       scripts/api/nginx.conf
```

- [ ] **Step 7: Run tests and check the user-data size**

```bash
cd ctech-dfe/cdk
npm install @aoctech/cdk@^0.3.0
npm test && npx tsc --noEmit
CTECH_VPC_ID=$(aws ssm get-parameter --name /ctech/dev/network/vpc-id --query Parameter.Value --output text) \
  ENVIRONMENT=dev npx cdk synth CtechDfe-Dev-Api > /tmp/dfe.json
node -e 'const t=require("/tmp/dfe.json");const lt=Object.values(t.Resources).find(r=>r.Type==="AWS::EC2::LaunchTemplate");console.log("user data bytes:",JSON.stringify(lt.Properties.LaunchTemplateData.UserData).length)'
```

Expected: tests pass; user data well under 4096 bytes.

- [ ] **Step 8: Deploy to dev and verify a boot**

```bash
ENVIRONMENT=dev npx cdk deploy CtechDfe-Dev-Api
# then, on the new instance via SSM Session Manager:
sudo tail -100 /var/log/cloud-init-output.log
curl -sf http://127.0.0.1:8080/v1.0/health-check
systemctl is-active app nginx
```

Expected: cloud-init exits 0, health check returns 200, both units active.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "refactor(cdk): boot the API from the shared ctech-cdk EC2 scripts"
```

---

## Task 13: Migrate ctech-account

**Files:**
- Modify: `ctech-account/cdk/lib/compute-stack.ts:62-300`
- Modify: `ctech-account/cdk/lib/iam-stack.ts:60-97`
- Modify: `ctech-account/cdk/package.json`

**Interfaces:**
- Consumes: the same as Task 12.
- Produces: nothing other repositories depend on.

ctech-account differs from ctech-dfe in three ways that matter: its nginx rate limit is `20r/s` not `100r/s`, its `client_max_body_size` is `5m` not `1m`, its binary is `bootstrap` not `app`, and it needs `/var/lib/ctech-account` for the MaxMind database.

- [ ] **Step 1: Write the failing test**

Create `ctech-account/cdk/test/compute-stack.test.ts` if absent, else append:

```ts
test('compute user data is script invocations, not inline files', () => {
  const template = Template.fromStack(computeStack);
  const [launchTemplate] = Object.values(
    template.findResources('AWS::EC2::LaunchTemplate'),
  ) as any[];
  const userData = JSON.stringify(launchTemplate.Properties.LaunchTemplateData.UserData);

  assert.match(userData, /ctech_run setup-nginx.sh '8080' '8000' '\/v1.0\/health-check' '20' '5m'/);
  assert.match(userData, /setup-app-service.sh 'CTech Account API' 'bootstrap'/);
  assert.doesNotMatch(userData, /limit_req_zone/, 'nginx.conf must no longer be inline');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ctech-account/cdk && npm test`
Expected: FAIL — the user data still contains `limit_req_zone`.

- [ ] **Step 3: Replace the user data**

In `ctech-account/cdk/lib/compute-stack.ts`, delete everything from `const userData = ec2.UserData.forLinux();` through the closing `);` of the final `userData.addCommands(` block, and the five `add*Commands` imports. Replace with:

```ts
    const scripts = new Ec2ScriptRunner(this, 'Scripts', {environment});
    const userData = ec2.UserData.forLinux();
    scripts.install(userData);

    scripts.run(userData, 'setup-base.sh', svcName, 'nginx');
    scripts.run(userData, 'setup-swap.sh', '256');
    scripts.run(userData, 'setup-dualstack.sh');
    scripts.run(userData, 'setup-cloudflare-ca.sh');

    userData.addCommands(
      `cat > /etc/app-static.env << 'ENV'`,
      `ENVIRONMENT=${environment}`,
      `TABLE_PREFIX=${environment}`,
      `AWS_REGION=${this.region}`,
      `AWS_USE_DUALSTACK_ENDPOINT=true`,
      `PORT=8000`,
      `KYC_DOCUMENTS_BUCKET=${kycDocumentsBucketName}`,
      `MAXMIND_DB_PATH=/var/lib/ctech-account/GeoLite2-City.mmdb`,
      `TRUSTED_PROXIES=127.0.0.1`,
      `ENV`,
    );

    scripts.run(userData, 'setup-ssm-env.sh',
      `SECRET_ENC_KEY=/ctech-account/${environment}/secret-encryption-key`,
      `BASE_URL=/ctech-account/${environment}/base-url`,
      `ALLOWED_ORIGINS=/ctech-account/${environment}/allowed-origins`,
      `APP_URL=/ctech-account/${environment}/app-url`,
      `WEBAUTHN_RPID=/ctech-account/${environment}/webauthn-rpid`,
      `GOOGLE_CLIENT_ID=/ctech-account/${environment}/google-client-id`,
      `GOOGLE_CLIENT_SECRET=/ctech-account/${environment}/google-client-secret`,
      `COOKIE_DOMAIN=/ctech-account/${environment}/cookie-domain`,
      `FROM_EMAIL=/ctech-account/${environment}/from-email`,
      `MAXMIND_ACCOUNT_ID=/ctech-account/${environment}/maxmind-account-id`,
      `MAXMIND_LICENSE_KEY=/ctech-account/${environment}/maxmind-license-key`,
      ...(valkeyUrlSsmPath ? [`VALKEY_URL=${valkeyUrlSsmPath}`] : []),
    );

    scripts.run(userData, 'setup-realip.sh', vpc.vpcCidrBlock);
    // 20 r/s and a 5 MB body: ctech-account's login and token routes are the
    // account-takeover surface, and its uploads are KYC documents.
    scripts.run(userData, 'setup-nginx.sh', '8080', '8000', '/v1.0/health-check', '20', '5m');
    scripts.run(userData, 'setup-app-service.sh', 'CTech Account API', 'bootstrap',
      'network.target nginx.service');
    scripts.run(userData, 'setup-deploy.sh', deploymentsBucketName, 'bootstrap',
      'http://127.0.0.1:8080/v1.0/health-check');
    scripts.run(userData, 'setup-logs.sh', logsBucketName, svcName, svcName,
      '/var/log/app', '/var/log/nginx');

    userData.addCommands(
      `cat > /tmp/cwagent.json << 'CWA'`,
      buildCloudWatchAgentConfig({
        metricNamespace: `CtechAccount/${environment}/Host`,
        appProcessPattern: '/opt/app/current/(app|bootstrap)',
        logFiles: [
          {filePath: '/var/log/app/app.log', logGroupName: logGroupApp, logStreamName: '{instance_id}'},
          {filePath: '/var/log/nginx/access.log', logGroupName: logGroupNginx, logStreamName: '{instance_id}/access'},
          {filePath: '/var/log/nginx/error.log', logGroupName: logGroupNginx, logStreamName: '{instance_id}/error'},
        ],
      }),
      `CWA`,
    );
    scripts.run(userData, 'setup-cloudwatch-agent.sh', '/tmp/cwagent.json');
    scripts.run(userData, 'bootstrap-deploy.sh', deploymentsBucketName, 'ctech-account/current.zip');
```

`TRUSTED_PROXIES=127.0.0.1` moves from the old inline `start.sh` into `/etc/app-static.env`, where it belongs — it is not a secret and never varied.

Update the imports:

```ts
import {buildCloudWatchAgentConfig, Ec2ScriptRunner, HaproxyEc2Service} from '@aoctech/cdk';
```

- [ ] **Step 4: Grant the instance role access to the scripts bucket**

In `ctech-account/cdk/lib/iam-stack.ts`, before the `CfnInstanceProfile`, add:

```ts
    role.addToPolicy(new iam.PolicyStatement({
      sid: 'ReadSharedEc2BootstrapScripts',
      actions: ['s3:GetObject'],
      resources: [`arn:aws:s3:::${environment}-ctech-ec2-scripts/*`],
    }));
```

Use the identifier the file already gives the instance role.

- [ ] **Step 5: Run tests and check the user-data size**

```bash
cd ctech-account/cdk
npm install @aoctech/cdk@^0.3.0
npm test && npx tsc --noEmit
CTECH_VPC_ID=$(aws ssm get-parameter --name /ctech/dev/network/vpc-id --query Parameter.Value --output text) \
  ENVIRONMENT=dev npx cdk synth > /tmp/account.json
```

Expected: PASS, user data under 4096 bytes.

- [ ] **Step 6: Deploy to dev and verify a boot**

Same checks as Task 12 Step 8, with `/opt/app/current/bootstrap` as the binary.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor(cdk): boot the API from the shared ctech-cdk EC2 scripts"
```

---

## Task 14: Migrate ctech-wallet

**Files:**
- Modify: `ctech-wallet/cdk/lib/api-stack.ts:78-437`
- Modify: `ctech-wallet/cdk/lib/iam-stack.ts`
- Modify: `ctech-wallet/cdk/package.json`

**Interfaces:**
- Consumes: the same as Task 12.
- Produces: nothing other repositories depend on.

ctech-wallet is the service at the 16 KB ceiling and the one with the most per-service nginx. Two things do not fit the shared shape:
- a `location = /v1.0/ws` WebSocket block, which becomes `/etc/nginx/conf.d/location-ws.conf`;
- `VALKEY_URL` needs the wallet's DB number appended to the shared base URL, which becomes `/opt/app/service-env.sh`.

- [ ] **Step 1: Write the failing test**

Append to `ctech-wallet/cdk/test/api-stack.test.ts`:

```ts
test('wallet user data keeps the WebSocket location and the Valkey DB suffix', () => {
  const template = Template.fromStack(apiStack);
  const [launchTemplate] = Object.values(
    template.findResources('AWS::EC2::LaunchTemplate'),
  ) as any[];
  const userData = JSON.stringify(launchTemplate.Properties.LaunchTemplateData.UserData);

  assert.match(userData, /location-ws.conf/);
  assert.match(userData, /proxy_set_header Upgrade \$http_upgrade/);
  assert.match(userData, /service-env.sh/);
  assert.match(userData, /VALKEY_BASE%\//, 'the DB number must still be appended');
  assert.doesNotMatch(userData, /limit_req_zone/, 'nginx.conf must no longer be inline');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ctech-wallet/cdk && npm test`
Expected: FAIL — the user data still contains `limit_req_zone`.

- [ ] **Step 3: Replace the user data**

In `ctech-wallet/cdk/lib/api-stack.ts`, delete from `const userData = ec2.UserData.forLinux();` to the closing `);` of the last `userData.addCommands(` block, and replace with:

```ts
    const scripts = new Ec2ScriptRunner(this, 'Scripts', {environment});
    const userData = ec2.UserData.forLinux();
    scripts.install(userData);

    scripts.run(userData, 'setup-base.sh', svcName, 'nginx');
    scripts.run(userData, 'setup-swap.sh', '256');
    scripts.run(userData, 'setup-dualstack.sh');
    scripts.run(userData, 'setup-cloudflare-ca.sh');

    userData.addCommands(
      `cat > /etc/app-static.env << 'ENV'`,
      `ENVIRONMENT=${environment}`,
      // repositories.NewBase joins prefix + "_" + table → "${environment}_wallets".
      `TABLE_PREFIX=${tablePrefix(environment)}`,
      `AWS_REGION=${this.region}`,
      `AWS_USE_DUALSTACK_ENDPOINT=true`,
      `PORT=${APP_PORT}`,
      `GAMBLING_ENABLED=true`,
      `PIX_GATEWAY_FUNCTION_NAME=${pixGatewayFunctionName}`,
      `TRUSTED_PROXIES=127.0.0.1`,
      `ENV`,
    );

    scripts.run(userData, 'setup-ssm-env.sh',
      `VALKEY_BASE=${shared.valkeyUrl}`,
      `CTECH_URL=${account.internalBaseUrl}`,
      `CTECH_ISSUER_URL=${account.appUrl}`,
      `CTECH_JWKS_URL=${account.internalJwksUrl}`,
      `SERVICE_AUDIENCE=${wallet.appUrl}`,
      `WALLET_CLIENT_ID=${wallet.walletClientId}`,
      `WALLET_CLIENT_SECRET=${wallet.walletClientSecret}`,
    );

    // The shared Valkey URL carries no DB number; each service appends the one it
    // owns. /0 and /1 belong to ctech-dfe and ctech-account, so the wallet uses
    // /2 — its per-wallet SETNX locks must never share a keyspace. An empty base
    // leaves VALKEY_URL empty and the app falls back to the in-memory backend.
    userData.addCommands(
      `cat > /opt/app/service-env.sh << 'SERVICEENV'`,
      `if [ -n "$VALKEY_BASE" ]; then VALKEY_URL="\${VALKEY_BASE%/}/${VALKEY_DB}"; else VALKEY_URL=""; fi`,
      `CORS_ALLOWED_ORIGINS="$SERVICE_AUDIENCE"`,
      `export VALKEY_URL CORS_ALLOWED_ORIGINS`,
      `SERVICEENV`,
      `chmod 0755 /opt/app/service-env.sh`,
    );

    // The app's WebSocket upgrader rejects a request whose Upgrade/Connection
    // headers were not forwarded ("not using the websocket protocol").
    userData.addCommands(
      `cat > /etc/nginx/conf.d/location-ws.conf << 'WSLOC'`,
      `location = /v1.0/ws {`,
      `    proxy_pass http://app;`,
      `    proxy_http_version 1.1;`,
      `    proxy_set_header Upgrade $http_upgrade;`,
      `    proxy_set_header Connection $connection_upgrade;`,
      `    proxy_set_header Host $host;`,
      `    proxy_set_header X-Real-IP $remote_addr;`,
      `    proxy_set_header X-Forwarded-For $remote_addr;`,
      `    proxy_set_header X-Forwarded-Proto $http_x_forwarded_proto;`,
      `    proxy_read_timeout 3600s;`,
      `    proxy_send_timeout 3600s;`,
      `    proxy_buffering off;`,
      `}`,
      `WSLOC`,
    );

    scripts.run(userData, 'setup-realip.sh', vpc.vpcCidrBlock);
    scripts.run(userData, 'setup-nginx.sh', `${NGINX_PORT}`, `${APP_PORT}`, HEALTH_CHECK_PATH, '100', '1m');
    scripts.run(userData, 'setup-app-service.sh', 'CTech Wallet API', 'app',
      'network.target nginx.service');
    scripts.run(userData, 'setup-deploy.sh', deploymentsBucketName, 'app',
      `http://127.0.0.1:${NGINX_PORT}${HEALTH_CHECK_PATH}`);
    scripts.run(userData, 'setup-logs.sh', logsBucketName, S3_PREFIX, SERVICE,
      '/var/log/app', '/var/log/nginx');

    userData.addCommands(
      `cat > /tmp/cwagent.json << 'CWA'`,
      buildCloudWatchAgentConfig({
        metricNamespace: `CtechWallet/${environment}/Host`,
        appProcessPattern: '/opt/app/current/(app|bootstrap)',
        logFiles: [
          {filePath: '/var/log/app/app.log', logGroupName: logGroupApp, logStreamName: '{instance_id}'},
          {filePath: '/var/log/nginx/access.log', logGroupName: logGroupNginx, logStreamName: '{instance_id}/access'},
          {filePath: '/var/log/nginx/error.log', logGroupName: logGroupNginx, logStreamName: '{instance_id}/error'},
        ],
      }),
      `CWA`,
    );
    scripts.run(userData, 'setup-cloudwatch-agent.sh', '/tmp/cwagent.json');
    scripts.run(userData, 'bootstrap-deploy.sh', deploymentsBucketName, API_CURRENT_ARTIFACT_KEY);
```

Update the import to add `Ec2ScriptRunner` and drop the five `add*Commands` names.

- [ ] **Step 4: Grant the instance role access to the scripts bucket**

In `ctech-wallet/cdk/lib/iam-stack.ts`, add the same `ReadSharedEc2BootstrapScripts` statement shown in Task 13 Step 4 to the API instance role.

- [ ] **Step 5: Run tests and check the user-data size**

```bash
cd ctech-wallet/cdk
npm install @aoctech/cdk@^0.3.0
npm test && npx tsc --noEmit
```

Expected: PASS, user data under 4096 bytes — down from roughly 16 KB.

- [ ] **Step 6: Deploy to dev and verify a boot, including the WebSocket route**

```bash
ENVIRONMENT=dev npx cdk deploy CtechWallet-Dev-Api
# on the instance:
sudo nginx -T | grep -A3 'location = /v1.0/ws'
curl -sf http://127.0.0.1:8080/v1.0/health-check
grep VALKEY_URL /opt/app/service-env.sh
```

Expected: the WebSocket location is present in the live config and the Valkey DB suffix is applied.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor(cdk): boot the API from the shared ctech-cdk EC2 scripts"
```

---

## Task 15: Migrate ctech-poker

**Files:**
- Modify: `ctech-poker/cdk/lib/api-stack.ts:210-410`
- Modify: `ctech-poker/cdk/lib/api-stack.ts:138` (instance profile role)
- Modify: `ctech-poker/cdk/package.json`

**Interfaces:**
- Consumes: the same as Task 12.
- Produces: nothing other repositories depend on.

ctech-poker has no nginx: HAProxy reaches the app port directly. It calls neither `setup-nginx.sh` nor `setup-realip.sh`, and its `TRUSTED_PROXIES` is the VPC CIDR rather than `127.0.0.1`. Its logs live only under `/var/log/app`.

- [ ] **Step 1: Write the failing test**

Append to `ctech-poker/cdk/test/api-stack.test.ts`:

```ts
test('poker user data runs no nginx or realip script', () => {
  const template = Template.fromStack(apiStack);
  const [launchTemplate] = Object.values(
    template.findResources('AWS::EC2::LaunchTemplate'),
  ) as any[];
  const userData = JSON.stringify(launchTemplate.Properties.LaunchTemplateData.UserData);

  assert.match(userData, /ctech_run setup-base.sh 'ctech-poker'/);
  assert.doesNotMatch(userData, /setup-nginx.sh/);
  assert.doesNotMatch(userData, /setup-realip.sh/);
  assert.match(userData, /TURNSTILE_EXPECTED_HOSTNAME/, 'derived in service-env.sh');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ctech-poker/cdk && npm test`
Expected: FAIL — `ctech_run` is absent from the rendered user data.

- [ ] **Step 3: Replace the user data**

In `ctech-poker/cdk/lib/api-stack.ts`, delete from `const userData = ec2.UserData.forLinux();` to the closing `);` of the last `userData.addCommands(` block, and replace with:

```ts
    const scripts = new Ec2ScriptRunner(this, 'Scripts', {environment});
    const userData = ec2.UserData.forLinux();
    scripts.install(userData);

    // No nginx: HAProxy reaches the app port directly (see APP_PORT in constants.ts).
    scripts.run(userData, 'setup-base.sh', SERVICE);
    scripts.run(userData, 'setup-swap.sh', '256');
    scripts.run(userData, 'setup-dualstack.sh');
    scripts.run(userData, 'setup-cloudflare-ca.sh');

    userData.addCommands(
      `cat > /etc/app-static.env << 'ENV'`,
      `ENVIRONMENT=${environment}`,
      `AWS_REGION=${this.region}`,
      `AWS_USE_DUALSTACK_ENDPOINT=true`,
      `PORT=${APP_PORT}`,
      // No localhost nginx hop: trust only peers inside this VPC before
      // honoring X-Forwarded-For.
      `TRUSTED_PROXIES=${vpc.vpcCidrBlock}`,
      `AVATAR_BUCKET=${avatarsBucketName}`,
      `ENV`,
    );

    scripts.run(userData, 'setup-ssm-env.sh',
      `VALKEY_URL=${shared.valkeyUrl}`,
      `CTECH_URL=${account.internalBaseUrl}`,
      `CTECH_ISSUER_URL=${account.appUrl}`,
      `CTECH_JWKS_URL=${account.internalJwksUrl}`,
      `SERVICE_AUDIENCE=${poker.appUrl}`,
      `WALLET_URL=${walletUrlParam}`,
      `POKER_CLIENT_ID=${pokerClientIdParam}`,
      `POKER_CLIENT_SECRET=${pokerClientSecretParam}`,
      `TURNSTILE_SECRET=${turnstileSecretParam}`,
      `WALLET_WEBHOOK_HMAC_SECRET=${walletWebhookHmacSecretParam}`,
      `REAL_MONEY_ENABLED=${realMoneyEnabledParam}`,
      `SOCIAL_GRAPH_ENABLED=${socialGraphEnabledParam}`,
      `LEGAL_SIGNOFF_REF=${legalSignoffRefParam}`,
      `AVATAR_BASE_URL=${avatarBaseUrlParam}`,
    );

    // Both kill switches are read fresh on every start, so ops can flip them in
    // SSM without a redeploy. An absent parameter yields an empty string; the
    // defaults here keep config.Load() failing closed.
    userData.addCommands(
      `cat > /opt/app/service-env.sh << 'SERVICEENV'`,
      `CORS_ALLOWED_ORIGINS="$SERVICE_AUDIENCE"`,
      `TURNSTILE_EXPECTED_HOSTNAME="\${SERVICE_AUDIENCE#*://}"`,
      `TURNSTILE_EXPECTED_HOSTNAME="\${TURNSTILE_EXPECTED_HOSTNAME%%/*}"`,
      `REAL_MONEY_ENABLED="\${REAL_MONEY_ENABLED:-false}"`,
      `SOCIAL_GRAPH_ENABLED="\${SOCIAL_GRAPH_ENABLED:-false}"`,
      `export CORS_ALLOWED_ORIGINS TURNSTILE_EXPECTED_HOSTNAME REAL_MONEY_ENABLED SOCIAL_GRAPH_ENABLED`,
      `SERVICEENV`,
      `chmod 0755 /opt/app/service-env.sh`,
    );

    scripts.run(userData, 'setup-app-service.sh', 'CTech Poker API', 'app', 'network.target');
    scripts.run(userData, 'setup-deploy.sh', deploymentsBucketName, 'app',
      `http://127.0.0.1:${APP_PORT}${HEALTH_CHECK_PATH}`);
    scripts.run(userData, 'setup-logs.sh', logsBucketName, S3_PREFIX, SERVICE, '/var/log/app');

    userData.addCommands(
      `cat > /tmp/cwagent.json << 'CWA'`,
      buildCloudWatchAgentConfig({
        metricNamespace: `CtechPoker/${environment}/Host`,
        appProcessPattern: '/opt/app/current/(app|bootstrap)',
        logFiles: [
          {filePath: '/var/log/app/app.log', logGroupName: logGroupApp, logStreamName: '{instance_id}'},
        ],
      }),
      `CWA`,
    );
    scripts.run(userData, 'setup-cloudwatch-agent.sh', '/tmp/cwagent.json');
    scripts.run(userData, 'bootstrap-deploy.sh', deploymentsBucketName, API_CURRENT_ARTIFACT_KEY);
```

An empty `REAL_MONEY_ENABLED` from a missing parameter now defaults to `false` in `service-env.sh`, matching the `|| echo "false"` the old inline `start.sh` used.

- [ ] **Step 4: Grant the instance role access to the scripts bucket**

`ctech-poker` creates its instance profile in `api-stack.ts` around line 138. Add to the role it references:

```ts
    apiRole.addToPolicy(new iam.PolicyStatement({
      sid: 'ReadSharedEc2BootstrapScripts',
      actions: ['s3:GetObject'],
      resources: [`arn:aws:s3:::${environment}-ctech-ec2-scripts/*`],
    }));
```

- [ ] **Step 5: Run tests and check the user-data size**

```bash
cd ctech-poker/cdk
npm install @aoctech/cdk@^0.3.0
npm test && npx tsc --noEmit
```

Expected: PASS, user data under 4096 bytes.

- [ ] **Step 6: Deploy to dev and verify a boot**

```bash
ENVIRONMENT=dev npx cdk deploy CtechPoker-Dev-Api
# on the instance:
curl -sf "http://127.0.0.1:8000/v1.0/health-check"
grep TURNSTILE_EXPECTED_HOSTNAME /opt/app/service-env.sh
```

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor(cdk): boot the API from the shared ctech-cdk EC2 scripts"
```

---

## Task 16: Migrate ctech-billing (Terraform)

**Files:**
- Modify: `ctech-billing/terraform/billing/compute.tf:76-124`
- Modify: `ctech-billing/terraform/assets/bootstrap.sh.tftpl` (701 lines → the service-specific remainder)
- Modify: `ctech-billing/terraform/billing/iam.tf`
- Modify: `ctech-billing/terraform/billing/locals.tf` (add the two shared SSM paths)

**Interfaces:**
- Consumes: `/ctech/{env}/ec2-scripts/bucket` and `/ctech/{env}/ec2-scripts/version`.
- Produces: nothing other repositories depend on.

`bootstrap.sh.tftpl` is a line-by-line port of ctech-wallet's user data and is the source most of `assets/ec2/` was extracted from. After this task it keeps only what is genuinely billing's: `/etc/app-static.env`, the SSM parameter list, the leader-election scheduled jobs, and any nginx directive the diff in Step 2 shows is not in the shared config.

- [ ] **Step 1: Add the shared SSM paths**

In `ctech-billing/terraform/billing/locals.tf`, add to the `shared_ssm` map:

```hcl
    ec2_scripts_bucket  = "/ctech/${var.environment}/ec2-scripts/bucket"
    ec2_scripts_version = "/ctech/${var.environment}/ec2-scripts/version"
```

In `ctech-billing/terraform/billing/compute.tf`, add next to the other `aws_ssm_parameter` data sources:

```hcl
data "aws_ssm_parameter" "ec2_scripts_bucket" {
  name = local.shared_ssm.ec2_scripts_bucket
}

data "aws_ssm_parameter" "ec2_scripts_version" {
  name = local.shared_ssm.ec2_scripts_version
}
```

- [ ] **Step 2: Produce the nginx diff**

```bash
cd ctech-billing/terraform
sed -n "/^cat > \/etc\/nginx\/nginx.conf << 'NGINX'$/,/^NGINX$/p" \
  ../../ctech-cdk/assets/ec2/setup-nginx.sh | sed '1d;$d' > /tmp/shared-nginx.conf
sed -n "/^cat > \/etc\/nginx\/nginx.conf << 'NGINX'$/,/^NGINX$/p" \
  assets/bootstrap.sh.tftpl | sed '1d;$d' > /tmp/billing-nginx.conf
diff -u /tmp/shared-nginx.conf /tmp/billing-nginx.conf
```

Directives present only in billing's copy go to `/etc/nginx/conf.d/http-billing.conf` or `location-billing.conf`, written by the remaining template. Record anything deliberately dropped in the commit message.

- [ ] **Step 3: Reduce the template**

In `ctech-billing/terraform/assets/bootstrap.sh.tftpl`, delete the sections now owned by the shared scripts — packages/user/directories, swap, dual-stack, Cloudflare CA, realip, the nginx heredoc, `app.service`, `start.sh`, `deploy.sh`, `upload-logs.sh`, logrotate, and the first-boot deploy — and replace them with:

```bash
#!/bin/bash
# Billing's remainder after the shared bootstrap moved to ctech-cdk's assets/ec2.
# Names in ${"$"}{...} are substituted by templatefile(); $${...} is left for bash.
set -euxo pipefail

CTECH_SCRIPTS="s3://${ec2_scripts_bucket}/${ec2_scripts_version}"
ctech_run(){ s="$1"; shift; aws s3 cp "$CTECH_SCRIPTS/$s" "/tmp/$s" >/dev/null; bash "/tmp/$s" "$@"; }

ctech_run setup-base.sh ctech-billing nginx
ctech_run setup-swap.sh 256
ctech_run setup-dualstack.sh
ctech_run setup-cloudflare-ca.sh

cat > /etc/app-static.env << 'ENV'
ENVIRONMENT=${environment}
TABLE_PREFIX=${table_prefix}
AWS_REGION=${aws_region}
AWS_USE_DUALSTACK_ENDPOINT=true
PORT=${app_port}
CHECKOUT_BASE_URL=${checkout_base_url}
PORTAL_ORGANIZATION_ID=${portal_organization_id}
CORS_ALLOWED_ORIGINS=${cors_allowed_origins}
SERVICE_AUDIENCE=${service_audience}
TRUSTED_PROXIES=127.0.0.1
ENV

ctech_run setup-ssm-env.sh \
  VALKEY_BASE=${ssm_valkey_url} \
  CTECH_URL=${ssm_account_internal_url} \
  CTECH_ISSUER_URL=${ssm_account_app_url} \
  CTECH_JWKS_URL=${ssm_account_jwks_url} \
  WALLET_URL=${ssm_wallet_internal_url} \
  WALLET_CLIENT_ID=${ssm_wallet_client_id} \
  WALLET_CLIENT_SECRET=${ssm_wallet_client_secret} \
  WALLET_WEBHOOK_SECRET=${ssm_wallet_webhook_secret} \
  CHECKOUT_LINK_SECRET=${ssm_checkout_link_secret} \
  FIELD_ENCRYPTION_KEY=${ssm_field_encryption_key} \
  EMAIL_FROM=${ssm_email_from}

cat > /opt/app/service-env.sh << 'SERVICEENV'
if [ -n "$VALKEY_BASE" ]; then VALKEY_URL="$${VALKEY_BASE%/}/${valkey_db}"; else VALKEY_URL=""; fi
export VALKEY_URL
SERVICEENV
chmod 0755 /opt/app/service-env.sh

ctech_run setup-realip.sh ${vpc_cidr}
ctech_run setup-nginx.sh ${nginx_port} ${app_port} ${health_path}
ctech_run setup-app-service.sh "CTech Billing API" app "network.target nginx.service"
ctech_run setup-deploy.sh ${deployments_bucket} app "http://127.0.0.1:${nginx_port}${health_path}"
ctech_run setup-logs.sh ${logs_bucket} ${s3_prefix} ctech-billing /var/log/app /var/log/nginx
```

Keep the CloudWatch agent config heredoc and the leader-election job units exactly as they are, then finish with:

```bash
ctech_run setup-cloudwatch-agent.sh /tmp/cwagent.json
ctech_run bootstrap-deploy.sh ${deployments_bucket} ${current_artifact_key}
```

- [ ] **Step 4: Drop the gzip+base64 wrapper**

In `ctech-billing/terraform/billing/compute.tf`, replace the `user_data` local:

```hcl
locals {
  bootstrap_sh = templatefile("${path.module}/../assets/bootstrap.sh.tftpl", merge(
    local.userdata_template_vars,
    {
      ec2_scripts_bucket  = data.aws_ssm_parameter.ec2_scripts_bucket.value
      ec2_scripts_version = data.aws_ssm_parameter.ec2_scripts_version.value
    },
  ))

  # No gzip+base64 wrapper any more: the bulk it was compressing now lives in S3.
  user_data = base64encode(local.bootstrap_sh)
}
```

Keep `local.userdata_template_vars` as the existing map of template variables; rename the current inline map to that name if it is still written inline.

- [ ] **Step 5: Grant the instance role access to the scripts bucket**

In `ctech-billing/terraform/billing/iam.tf`, add to the instance role policy document:

```hcl
statement {
  sid       = "ReadSharedEc2BootstrapScripts"
  actions   = ["s3:GetObject"]
  resources = ["arn:aws:s3:::${var.environment}-ctech-ec2-scripts/*"]
}
```

- [ ] **Step 6: Verify with a plan and a size check**

```bash
cd ctech-billing/terraform/billing
terraform init -upgrade && terraform validate
terraform plan -var environment=dev -out /tmp/billing.plan
terraform show -json /tmp/billing.plan \
  | jq -r '.. | .user_data? // empty' | head -1 | base64 -d | wc -c
```

Expected: `terraform validate` passes; the plan shows the launch template replaced; the decoded user data is under 4096 bytes, down from roughly 2 KB gzipped over a 24 KB script.

- [ ] **Step 7: Apply to dev and verify a boot**

```bash
terraform apply -var environment=dev
# on the instance:
sudo tail -100 /var/log/cloud-init-output.log
curl -sf http://127.0.0.1:8080/health
systemctl is-active app nginx
```

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "refactor(terraform): boot the API from the shared ctech-cdk EC2 scripts"
```

---

## Task 17: Migrate ctech-lbalancer (Terraform, partial)

**Files:**
- Modify: `ctech-lbalancer/assets/bootstrap.sh.tftpl`
- Modify: `ctech-lbalancer/terraform/lbalancer/compute.tf:1-60`
- Modify: `ctech-lbalancer/terraform/lbalancer/iam.tf`

**Interfaces:**
- Consumes: `/ctech/{env}/ec2-scripts/bucket` and `/ctech/{env}/ec2-scripts/version`.
- Produces: nothing other repositories depend on.

ctech-lbalancer adopts only four scripts. HAProxy compilation, the Cloudflare IP refresh, route reconciliation and the Authenticated Origin Pull mTLS setup are unique to it and stay in `assets/`. It runs no nginx, no `app.service`, and no `deploy.sh`.

- [ ] **Step 1: Add the SSM data sources**

In `ctech-lbalancer/terraform/lbalancer/compute.tf`:

```hcl
data "aws_ssm_parameter" "ec2_scripts_bucket" {
  name = "/ctech/${var.environment}/ec2-scripts/bucket"
}

data "aws_ssm_parameter" "ec2_scripts_version" {
  name = "/ctech/${var.environment}/ec2-scripts/version"
}
```

and add to `local.userdata_template_vars`:

```hcl
    ec2_scripts_bucket  = data.aws_ssm_parameter.ec2_scripts_bucket.value
    ec2_scripts_version = data.aws_ssm_parameter.ec2_scripts_version.value
```

- [ ] **Step 2: Replace the shared sections of bootstrap.sh.tftpl**

At the top of `ctech-lbalancer/assets/bootstrap.sh.tftpl`, after `set -euxo pipefail`, insert:

```bash
CTECH_SCRIPTS="s3://${ec2_scripts_bucket}/${ec2_scripts_version}"
ctech_run(){ s="$1"; shift; aws s3 cp "$CTECH_SCRIPTS/$s" "/tmp/$s" >/dev/null; bash "/tmp/$s" "$@"; }

# HAProxy is built from source further down; the base script installs the agents,
# the unprivileged user and crond that every CTech instance shares.
ctech_run setup-base.sh ctech-lbalancer
ctech_run setup-swap.sh 256
ctech_run setup-dualstack.sh
```

Then delete the corresponding blocks the template already contains: the `dnf install` of the agents and cronie, the `useradd`, the swap file, the `/etc/environment` line, the SSM agent JSON, and the CloudWatch agent systemd override. Leave every HAProxy-specific `dnf install` in place.

Replace the CloudWatch agent activation line with:

```bash
ctech_run setup-cloudwatch-agent.sh /tmp/cwagent.json
```

keeping the heredoc that writes `/tmp/cwagent.json` — its log group and namespace are Terraform values.

- [ ] **Step 3: Shrink the user_data wrapper**

In `ctech-lbalancer/terraform/lbalancer/compute.tf`, keep the gzip+base64 install for `reconcile.sh` and `refresh-cloudflare-ips.sh` — those are large and genuinely lbalancer's — but the shrunk `bootstrap.sh` no longer needs it:

```hcl
  user_data = base64encode(<<-EOF
    #!/bin/bash
    set -euxo pipefail
    mkdir -p /opt/ctech-lbalancer /etc/haproxy/tls /var/lib/haproxy /var/log/haproxy

    echo '${base64gzip(local.reconcile_sh)}' | base64 -d | gzip -d > /opt/ctech-lbalancer/reconcile.sh
    chmod 0750 /opt/ctech-lbalancer/reconcile.sh

    echo '${base64gzip(local.refresh_cloudflare_ips_sh)}' | base64 -d | gzip -d > /opt/ctech-lbalancer/refresh-cloudflare-ips.sh
    chmod 0750 /opt/ctech-lbalancer/refresh-cloudflare-ips.sh

    echo '${base64gzip(local.bootstrap_sh)}' | base64 -d | gzip -d > /opt/ctech-lbalancer/bootstrap.sh
    chmod 0750 /opt/ctech-lbalancer/bootstrap.sh

    /opt/ctech-lbalancer/bootstrap.sh
    EOF
  )
```

This is unchanged; only `local.bootstrap_sh` got smaller. Note in the commit message that the wrapper stays because `reconcile.sh` alone still needs it.

- [ ] **Step 4: Grant the instance role access to the scripts bucket**

In `ctech-lbalancer/terraform/lbalancer/iam.tf`, add:

```hcl
statement {
  sid       = "ReadSharedEc2BootstrapScripts"
  actions   = ["s3:GetObject"]
  resources = ["arn:aws:s3:::${var.environment}-ctech-ec2-scripts/*"]
}
```

- [ ] **Step 5: Verify with a plan**

```bash
cd ctech-lbalancer/terraform/lbalancer
terraform init -upgrade && terraform validate
terraform plan -var environment=dev
```

Expected: validate passes; the plan replaces the launch template only.

- [ ] **Step 6: Apply to dev and verify a boot**

```bash
terraform apply -var environment=dev
# on the instance:
sudo tail -200 /var/log/cloud-init-output.log
systemctl is-active haproxy amazon-ssm-agent amazon-cloudwatch-agent
sudo haproxy -c -f /etc/haproxy/haproxy.cfg
```

Expected: HAProxy is active and its config validates. This instance is the public ingress for every service — verify a request through it before applying to production.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor(terraform): adopt the shared ctech-cdk EC2 base scripts"
```

---

## Rollout order and rollback

Deploy `Ec2ScriptsStack` in an environment before any service in that environment migrates (Task 11 Step 7). Migrate `dev` fully, then `stage`, then `prod`, service by service in the task order above.

Rollback for any service is `git revert` of its migration commit followed by a redeploy: the previous user data referenced no scripts bucket, so nothing external has to be restored. Rollback of a bad *script* is a revert in `ctech-cdk` plus `cdk deploy Ctech-<Env>-Ec2Scripts`, which restores the earlier hash — but services already deployed against the new hash keep pointing at it until they are redeployed, so a script revert must be followed by a redeploy of every migrated service in that environment.

## Self-review notes

Checked against `docs/specs/2026-08-18-ec2-user-data-assets.md`:

- Spec §1 script library — Tasks 1–7, all twelve scripts.
- Spec §2 distribution — Task 8. **Amended:** the spec's 90-day lifecycle rule is dropped; expiring by object age would delete the live prefix of an environment whose scripts had not changed in that window. The spec has been corrected.
- Spec §3 CDK consumption — Task 9.
- Spec §4 Terraform consumption — Tasks 16 and 17.
- Spec §5 IAM — Tasks 12–17, Step 4 of each.
- Spec §6 scheduled enable/disable — Task 10.
- Spec §7 migration order — Tasks 12–17, matching the spec's sequence.
- Spec "Verification" — the shell lint harness (Task 1), the synthesis assertions (Tasks 8–10), and the per-repository plan/synth/boot checks in Tasks 12–17.

Interface names used across tasks and verified consistent: `Ec2ScriptRunner.install/run/grantRead`, `SSM.ec2Scripts(env).{bucket,version}`, `AsgScheduleProps`, `addAsgSchedule`, `Ec2ScriptsStack.{bucketName,version}`, and the twelve script filenames.
