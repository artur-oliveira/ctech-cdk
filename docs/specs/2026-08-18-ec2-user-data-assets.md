# EC2 user-data assets

Date: 2026-08-18
Status: approved, not implemented
Repositories: ctech-cdk, ctech-account, ctech-dfe, ctech-wallet, ctech-poker,
ctech-billing, ctech-lbalancer

## Problem

Every CTech EC2 service builds its instance by writing files inline into
`ec2.UserData`. EC2 caps user data at 16 KB, and the largest services are at
that ceiling:

| Repository | Inline user data | Shared fragments | Total |
| --- | ---: | ---: | ---: |
| ctech-wallet | ~12.5 KB | ~3.5 KB | ~16.0 KB |
| ctech-account | ~11.0 KB | ~3.5 KB | ~14.5 KB |
| ctech-poker | ~7.9 KB | ~3.1 KB | ~11.0 KB |
| ctech-dfe | ~1.8 KB | ~3.5 KB | ~5.3 KB |

Byte counts are of the backtick-quoted user-data lines in each stack plus the
`@aoctech/cdk` fragments it composes. ctech-wallet cannot absorb another
feature without hitting the limit.

Three incompatible workarounds already exist:

- `ctech-dfe` ships its static files as an `s3assets.Asset` of
  `cdk/scripts/api` and writes only `/etc/bootstrap.env` inline.
- `ctech-billing` and `ctech-lbalancer` are Terraform: they render one large
  `bootstrap.sh.tftpl` and install it gzip+base64-encoded.
- `ctech-account`, `ctech-wallet` and `ctech-poker` remain fully inline.

The same nginx configuration, systemd unit, `deploy.sh`, `upload-logs.sh` and
logrotate stanza are therefore maintained in five places, in three encodings.
`ctech-billing/terraform/assets/bootstrap.sh.tftpl` is a 701-line line-by-line
port of ctech-wallet's user data; a fix applied to one copy does not reach the
others.

## Goal

User data becomes a short list of script invocations. Everything a script needs
that varies is passed as an argument or written to `/etc/bootstrap.env`. The
scripts themselves are ordinary shell files in `ctech-cdk`, shared by CDK and
Terraform consumers alike.

Target shape:

```bash
CTECH_SCRIPTS=s3://prod-ctech-ec2-scripts/a3f9c1e0…
ctech_run(){ s=$1; shift; aws s3 cp "$CTECH_SCRIPTS/$s" "/tmp/$s" >/dev/null; bash "/tmp/$s" "$@"; }

ctech_run setup-base.sh ctech-account nginx unzip jq
ctech_run setup-swap.sh 256
ctech_run setup-dualstack.sh
ctech_run setup-cloudflare-ca.sh
ctech_run setup-realip.sh 10.0.0.0/16
ctech_run setup-nginx.sh 8080 8000 /v1.0/health-check
…
```

## Non-goals

- Replacing the release-artifact deploy path. `deploy.sh` keeps its current
  contract: SSM RunCommand passes an S3 key, the script swaps
  `/opt/app/current` and health-checks.
- Baking an AMI. Boot-time installation stays.
- Moving service-specific secrets, ports or business alarms into `ctech-cdk`.
  Only the shape is shared.

## Design

### 1. Script library

Scripts live in `ctech-cdk/assets/ec2/` as executable shell files. They contain
no CDK templating: everything variable arrives as a positional argument or is
read from `/etc/bootstrap.env`. Each is idempotent — an instance that reruns one
must converge, not fail.

| Script | Arguments | Responsibility |
| --- | --- | --- |
| `setup-base.sh` | `<service> [extra-packages…]` | `dnf install`, `webapp` system user, `/opt/app/releases` + `/var/log/app`, enable `crond` |
| `setup-swap.sh` | `[sizeMb=256]` | `/var/swapfile` + fstab entry |
| `setup-dualstack.sh` | none | `AWS_USE_DUALSTACK_ENDPOINT` in `/etc/environment`, the SSM agent's own config, and the CloudWatch agent systemd override |
| `setup-cloudflare-ca.sh` | none | Download the Cloudflare Origin CA RSA root, verify the pinned SHA-256, install into the AL2023 trust store |
| `setup-realip.sh` | `<vpc-cidr>` | `/opt/app/update-realip.sh`, its systemd oneshot and daily timer, and one bootstrap run |
| `setup-nginx.sh` | `<nginx-port> <app-port> <health-path>` | Base `nginx.conf` with the shared realip/rate-limit/proxy shape |
| `setup-cloudwatch-agent.sh` | `<config-file>` | `amazon-cloudwatch-agent-ctl -a fetch-config` |
| `setup-app-service.sh` | `<description> <binary>` | `/etc/systemd/system/app.service`, `daemon-reload`, `enable` |
| `setup-ssm-env.sh` | `VAR=/ssm/path …` | Generate `/opt/app/load-ssm-env.sh`, which `start.sh` sources to export each variable |
| `setup-deploy.sh` | `<bucket> <binary> <health-url>` | `/opt/app/deploy.sh` |
| `setup-logs.sh` | `<logs-bucket> <s3-prefix> <log-dir…>` | `/opt/app/upload-logs.sh` and `/etc/logrotate.d/<service>` |
| `bootstrap-deploy.sh` | `<bucket> <key>` | `head-object` then `deploy.sh`, tolerating a missing artifact |

`ctech-billing/terraform/assets/bootstrap.sh.tftpl` is the primary source: it is
already a plain-shell rendering of the whole sequence and its comments carry the
reasoning behind each step. Extraction is a split of that file plus the
divergences the other four services introduced.

#### nginx variation

`setup-nginx.sh` emits the configuration common to ctech-account, ctech-dfe,
ctech-wallet and ctech-billing: the `realip*.conf` include, the JSON access-log
format, `req_by_ip`/`conn_by_ip` zones, the `app` upstream and the `/` and
health-check locations. Per-service additions — ctech-wallet's `/v1.0/ws`
WebSocket location, ctech-dfe's organization-keyed rate limit — ship as a
service-owned drop-in that the generated `http {}` block includes:

```nginx
include /etc/nginx/conf.d/service*.conf;
```

Rate limits differ per service (20 r/s for ctech-account, 100 r/s for
ctech-wallet), so the zone rate is a fourth optional argument defaulting to
100 r/s. ctech-poker runs with no nginx at all and simply does not call this
script.

### 2. Distribution

A new `Ec2ScriptsStack` in `ctech-cdk`, deployed per environment:

- Bucket `${env}-ctech-ec2-scripts`: `BLOCK_ALL` public access, S3-managed
  encryption, versioning on, `RemovalPolicy.RETAIN`.
- An `s3assets.Asset` over `assets/ec2` supplies `assetHash`. A
  `s3deploy.BucketDeployment` copies the asset into the bucket under
  `destinationKeyPrefix: <assetHash>`, with `prune: false` so older versions
  survive for instances still running them.
- Two SSM parameters:
  - `/ctech/{env}/ec2-scripts/bucket` — the bucket name;
  - `/ctech/{env}/ec2-scripts/version` — the asset hash.

`prune: false` means old prefixes accumulate, and the bucket deliberately has no
expiration rule. Expiring objects by age would delete the *live* prefix of any
environment whose scripts had not changed within the window, breaking every boot
after that. The scripts total a few kilobytes, so accumulation is not a cost
worth that failure mode.

### 3. Consumption from CDK

`Ec2ScriptRunner`, exported from `@aoctech/cdk`:

```ts
const scripts = new Ec2ScriptRunner(this, 'Scripts', {environment});
scripts.install(userData);
scripts.run(userData, 'setup-swap.sh', '256');
```

`install()` emits the `CTECH_SCRIPTS` assignment and the `ctech_run` function.
`run()` appends one invocation, shell-quoting each argument.

Both SSM values are read with `ssm.StringParameter.valueForStringParameter`,
which yields a CloudFormation token. CloudFormation resolves it at deploy time,
so the bucket name and the hash are literal text inside the launch template's
user data. This is what preserves instance refresh: editing a script changes the
asset hash, which changes the user data, which versions the launch template.
A fixed key would leave the user data byte-identical while the script changed
underneath running instances — the failure mode `ctech-dfe/cdk/lib/api-stack.ts`
documents at the `ApiBootstrap` asset.

Scripts are downloaded to `/tmp` and then run, rather than piped into `bash`. A
pipe that is truncated mid-transfer executes a partial script and reports
success; a separate `aws s3 cp` under `set -e` fails the boot instead.

### 4. Consumption from Terraform

`ctech-billing` and `ctech-lbalancer` read the same two parameters:

```hcl
data "aws_ssm_parameter" "ec2_scripts_bucket"  { name = "/ctech/${var.environment}/ec2-scripts/bucket" }
data "aws_ssm_parameter" "ec2_scripts_version" { name = "/ctech/${var.environment}/ec2-scripts/version" }
```

and emit the identical `ctech_run` prelude in their `bootstrap.sh.tftpl`. The
gzip+base64 install disappears with the bulk it was compressing.

ctech-lbalancer is the partial case: HAProxy compilation, Cloudflare IP refresh
and route reconciliation are unique to it and stay in its own assets. It adopts
`setup-base.sh`, `setup-swap.sh`, `setup-dualstack.sh` and
`setup-cloudwatch-agent.sh` only.

### 5. IAM

Instances need exactly one new permission:

```
s3:GetObject on arn:aws:s3:::${env}-ctech-ec2-scripts/*
```

The bucket name and version are already literal in the user data by the time the
instance boots, so no `ssm:GetParameter` is required for the bootstrap itself.
`ctech-cdk` exports `grantEc2ScriptsRead(role)` and the bucket ARN; each service
repository, which owns its own instance profile, applies it.

### 6. Scheduled ASG enable/disable

`HaproxyEc2Service` and `ValkeyStack` accept:

```ts
schedule?: {
  disableCron: string;   // default '0 22 * * *'
  enableCron: string;    // default '0 10 * * *'
  timeZone?: string;     // default 'America/Sao_Paulo'
}
```

`disableCron` sets min/max/desired to 0. `enableCron` restores the construct's
configured `minCapacity`, `maxCapacity` and `desiredCapacity`. Applied to every
environment, production included.

The uncommitted block at `lib/valkey-stack.ts:279-297` is replaced: it currently
gives both actions the same `0 1 * * *` cron and sets all three capacities to 0
on each, so the pair is a no-op that only ever scales down, and it carries no
`timeZone`, meaning the cron is UTC rather than BRT.

Operational consequence, accepted by the decision to include production: every
service and the shared Valkey are down from 22:00 to 10:00 BRT daily (01:00–13:00 UTC). Inbound
traffic in that window fails — ctech-billing webhooks, PIX callbacks, DF-e SEFAZ
distribution polling, and any scheduled job. Excluding production later is one
conditional at each call site.

### 7. Migration order

One pull request per repository, in dependency order. Each is independently
deployable and revertible; no repository is broken by the one before it.

1. `ctech-cdk`: scripts, `Ec2ScriptsStack`, `Ec2ScriptRunner`, the `schedule`
   prop, tests, docs. Publish `@aoctech/cdk` 0.3.0. The existing
   `add*Commands` fragments stay exported and working.
2. `ctech-dfe` — smallest diff, already asset-based; proves the contract.
3. `ctech-account`, `ctech-wallet`, `ctech-poker`.
4. `ctech-billing`, `ctech-lbalancer` — Terraform prelude.

After step 4, the `add*Commands` fragments have no consumers and are deprecated
for removal in `@aoctech/cdk` 1.0.0, alongside `PrivateIpv4Ec2Service`.

## Verification

- `bash -n` on every script, plus `shellcheck` where available, in CI.
- A `ctech-cdk` unit test synthesising a representative stack and asserting the
  user data contains the version token, contains no heredoc, and is under 4 KB.
- A test asserting the asset hash changes when a script changes, so the
  instance-refresh guarantee is covered rather than assumed.
- `npm test`, `npx tsc --noEmit`, and `cdk synth` in `ctech-cdk`.
- Per service repository: `cdk synth` (or `terraform plan`) and a boot of one
  instance in dev, checking `/var/log/cloud-init-output.log` and the health
  endpoint, before the production deploy.

## Risks

- **A bad script breaks every service at once.** Mitigated by the hash-prefixed
  key: a new hash is only referenced by launch templates deployed after it, and
  reverting the script restores the previous hash and therefore the previous
  launch template.
- **S3 unavailable at boot.** Instances already depend on S3 for the release
  artifact, so this adds no new dependency class. `aws s3 cp` retries.
- **Migration divergence.** The nginx shape differs slightly per service today.
  Reconciling them into one script is a behaviour change; each service's diff
  must be reviewed against its current rendered configuration, not just against
  the other services.
