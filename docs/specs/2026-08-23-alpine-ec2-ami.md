# Custom Alpine EC2 AMI

Date: 2026-08-23
Status: approved, not implemented
Repositories: ctech-cdk (primary); ctech-billing (pilot consumer); ctech-account,
ctech-wallet, ctech-dfe, ctech-poker, ctech-lbalancer (later, opt-in only)

## Problem

Every CTech EC2 service boots `ec2.MachineImage.latestAmazonLinux2023({..., edition:
MINIMAL})`. AL2023 minimal plus `amazon-cloudwatch-agent` and `aws-cli` alone does
not fit in a small root volume — current stacks (`dragonfly-stack.ts:416`,
`valkey-stack.ts:235`, `haproxy-ec2-service.ts:176`) default `rootVolumeGiB` to 3
(HAProxy service) or a hardcoded 3 (Valkey/Dragonfly). There is no path today to
the AWS absolute minimum of 1 GiB.

## Goal

A custom Alpine Linux AMI (ARM64) that:

- boots with the same IMDSv2/network defaults AWS gives AL2023 by default;
- runs Session Manager (shell access, `send-command` deploys) and ships
  application/nginx/valkey logs to CloudWatch Logs;
- fits its OS + shared agents + application in a 1 GiB (or as close to it as
  measurement allows) root volume, leaving room for a swapfile and log headroom;
- is rebuildable on a routine cadence (security releases) through a pipeline, not
  a one-off hand-built image.

## Non-goals

- Replacing AL2023 anywhere by force. Every current stack keeps working exactly
  as it does today; Alpine is opt-in per stack/per service.
- Metrics collection. Explicitly deferred — `ctech-ec2-agent` (below) ships logs
  only for now; a metrics subcommand is a later, separate change.
- A from-scratch AMI build (custom kernel, hand-rolled network/cloud-init). The
  pipeline starts from Alpine's own official AWS cloud image
  (alpinelinux.org/cloud), which already carries the ENA driver and cloud-init.
- Touching `DragonflyStack`/`lib/dragonfly-stack.ts`. It is not instantiated in
  `bin/ctech-cdk.ts` today (rolled back to `ValkeyStack` — see Documentation
  below) and is out of scope here.
- Duplicating `HaproxyEc2Service`. It already takes `machineImage` and
  `rootVolumeGiB` as props and contains no OS-specific logic — see Design §5.

## Design

### 1. AMI build pipeline (Packer)

- Source: Alpine's official AWS cloud image, ARM64, latest stable release.
- Tool: Packer (`amazon-ebs` builder), run from a new GitHub Actions workflow in
  this repo. A dedicated OIDC deploy role scoped to `ec2:RunInstances`,
  `ec2:CreateImage`, `ec2:RegisterImage`, `ec2:DescribeImages`, and the S3 actions
  Packer needs for its build instance — never `ctech-gha-infra`
  (`AdministratorAccess`, reserved for account-level CDK per this repo's
  `CLAUDE.md`).
- Provisioners (shell): `apk add` the fixed package set (§3), install
  `ctech-ec2-agent` (§4) from the shared scripts bucket, write the OpenRC service
  definitions (§5).
- Output: one AMI ID per build, tagged with the Alpine release and build date,
  published to `/ctech/{env}/ami/alpine/arm64` (new SSM path, alongside the
  existing `/ctech/{env}/ec2-scripts/*` convention).
- Trigger: manual dispatch to start, matching how `ec2-scripts` changes work
  today (a script edit only takes effect on the next `cdk deploy`). A scheduled
  monthly rebuild (Alpine security releases) is a fast-follow once the manual
  path is proven, not part of this change.

### 2. Disk budget (target 1 GiB, verified empirically)

Fixed known costs:

- `amazon-ssm-agent` (apk, aarch64): **100.3 MiB installed**, confirmed via
  pkgs.alpinelinux.org. Mandatory — Session Manager shell access and
  `send-command` deploys both depend on it running as a daemon.
- `aws-cli` (~100 MiB apk) and CloudWatch Agent (no Alpine/musl package exists)
  are **not installed at all** — both replaced by `ctech-ec2-agent` (§4).

Everything else — Alpine's own musl/apk/OpenRC/cloud-init base, `valkey-openrc`
or `nginx-openrc`, `ctech-ec2-agent` itself (~15–25 MiB, cross-compiled static
Go), and the application binary — is sized by measuring the first built image
(`du -sh /`, `df -h`), not assumed up front. The swapfile size (256 or 512 MiB)
is the tuning dial once the rest is known. 1 GiB is the target and is the AWS
GP3 minimum; if measurement shows it is too tight to leave headroom for logs,
the plan's validation step decides the real number (documented as a task, not
promised here).

### 3. Package/agent inventory

Installed via `apk add` in the Packer provisioner:

- `amazon-ssm-agent` + `amazon-ssm-agent-openrc` (Session Manager, RunCommand).
- `valkey` + `valkey-openrc` (Valkey path) or `nginx` + `nginx-openrc` (HAProxy
  service path) — both confirmed present in Alpine's `main` repo for aarch64.
- `ctech-ec2-agent` (own binary, §4) — not an apk package, fetched from the
  shared scripts bucket at bake time.

Not installed: `aws-cli`, `amazon-cloudwatch-agent`, `cronie` (Alpine's built-in
busybox crond + `/etc/periodic/*` replaces it — see §5).

### 4. `ctech-ec2-agent`

A single static Go binary (`CGO_ENABLED=0 GOOS=linux GOARCH=arm64`), using AWS
SDK for Go v2 with the default EC2 IMDS credential chain — same instance role
and IAM policies already attached today, no IAM change needed. It replaces
every current `aws` CLI call site found in this repo, plus the CloudWatch Agent's
log-shipping role:

| Subcommand | Replaces | Current call site |
| --- | --- | --- |
| `ssm-get` | `aws ssm get-parameter --with-decryption` | `assets/ec2/setup-ssm-env.sh:37` |
| `ssm-put` | `aws ssm put-parameter --overwrite` | `lib/valkey-stack.ts:223` |
| `prefix-list` | `aws ec2 describe-managed-prefix-lists` + `get-managed-prefix-list-entries` | `assets/ec2/setup-realip.sh` |
| `route53-upsert` | `aws route53 change-resource-record-sets` | `lib/valkey-stack.ts:219` |
| `s3-cp` | `aws s3 cp` | `assets/ec2/setup-deploy.sh` (generated `deploy.sh`) |
| `s3-head` | `aws s3api head-object` | `assets/ec2/bootstrap-deploy.sh` |
| `logs-tail` | CloudWatch Agent's log input (new, long-running) | — |

`logs-tail` is the one genuinely new piece of logic: tails one or more files,
detects rotation by inode change, batches and flushes on an interval,
`PutLogEvents` (no sequence-token bookkeeping needed — AWS dropped that
requirement in 2023), and persists a byte-offset cursor under
`/var/lib/ctech-ec2-agent/` so a restart does not re-ship or drop lines. It does
not attempt multi-line grouping, StatsD, procstat, or any other CloudWatch Agent
feature — logs only, by design (see Non-goals).

Source lives in this repo under `assets/ctech-ec2-agent/` (its own Go module),
built by CI before `cdk deploy` and published through the same
`Ec2ScriptsStack` mechanism as the shell scripts (§6) — kept here rather than in
`ctech-go-common` because it is account-level EC2 bootstrap tooling consumed the
same way as `assets/ec2/*.sh`, not a library another service imports.

### 5. systemd → OpenRC mapping

| AL2023 (systemd) today | Alpine (OpenRC) |
| --- | --- |
| `amazon-ssm-agent.service` | ships ready-made in `amazon-ssm-agent-openrc` |
| `cronie` + `/etc/cron.d/*` | Alpine's built-in busybox crond + `/etc/periodic/{daily,...}` |
| `valkey.service` | `valkey-openrc` (ready-made) |
| `nginx.service` | `nginx-openrc` (ready-made) |
| `app.service` / `app2.service` (`Restart=on-failure`, `RestartSec=30`) | custom init.d using `supervise-daemon` (native respawn, same semantics) |
| `amazon-cloudwatch-agent.service` + dualstack override.conf | removed; dualstack toggle becomes `/etc/conf.d/ctech-ec2-agent` |
| `update-realip.service` + `.timer` (`OnCalendar=daily`, `RandomizedDelaySec=1h`) | init.d oneshot invoked from `/etc/periodic/daily`; random delay is `sleep $((RANDOM % 3600))` inside the script itself (OpenRC has no timer unit) |

`setup-cloudflare-ca.sh` needs a real rewrite, not just a command swap: Alpine's
trust store uses `update-ca-certificates` + `/usr/local/share/ca-certificates/`
(Debian-style), not RHEL's `update-ca-trust` + `/etc/pki/ca-trust`.
`setup-swap.sh` needs no change — it is already OS-agnostic (`dd`/`mkswap`/
`fstab`), reused as-is.

### 6. File layout, CDK, publishing

- New scripts in `assets/ec2-alpine/*.sh`, one per existing `assets/ec2/*.sh`
  (except `setup-swap.sh`, shared unchanged), same argument contract so CDK and
  Terraform callers change only which script set they point at.
- `Ec2ScriptsStack` (`lib/ec2-scripts-stack.ts`) is extended, not replaced: two
  new content-hash-prefixed uploads to the same bucket
  (`assets/ec2-alpine/` and `assets/ctech-ec2-agent/dist/`), two new SSM
  pointers (`/ctech/{env}/ec2-scripts-alpine/{bucket,version}`,
  `/ctech/{env}/ctech-ec2-agent/{bucket,version}`).
- `ValkeyStackV2` (new file, `lib/valkey-stack-v2.ts`): same external contract as
  `ValkeyStack` (`/ctech/{env}/valkey/url`, `cache.internal.aoctech.app` — the
  two cannot coexist, same rule already documented for Dragonfly/Valkey in
  `bin/ctech-cdk.ts`), userData rewritten against the Alpine scripts,
  `machineImage: ec2.MachineImage.fromSsmParameter('/ctech/{env}/ami/alpine/arm64', {os: ec2.OperatingSystemType.LINUX})`,
  `rootVolumeGiB: 1` (pending §2's measurement).
- `HaproxyEc2Service`: **no new class.** It already accepts `machineImage` and
  `rootVolumeGiB`; only a new `lib/ec2-userdata-fragments-alpine.ts` (parallel to
  the existing `ec2-userdata-fragments.ts`) is added for CDK callers to compose
  Alpine userData from. Terraform callers (`ctech-billing`, `ctech-lbalancer`)
  compose the new `assets/ec2-alpine/*.sh` scripts directly in their own
  templates, exactly as they already do for the AL2023 scripts today.
- New AMI ID resolves via CloudFormation's SSM-parameter dynamic reference, so a
  rebuilt AMI only takes effect on the next `cdk deploy` of a consumer stack —
  matching the existing ec2-scripts behavior (a script change also only takes
  effect on next deploy). No automatic ASG instance refresh is added; that stays
  a manual/operational decision, same as today.

### 7. Rollout

Both pieces go straight to **prod**, no dev staging — decided explicitly:
ctech-billing carries no real traffic yet, and Valkey's cutover already
tolerates a brief empty-cache window by design (same as the existing
Dragonfly↔Valkey switch). Skipping dev is a deliberate scope decision, not an
oversight.

- `ValkeyStackV2` ships and cuts over directly in prod: delete
  `Ctech-Prod-ValKey`, deploy `Ctech-Prod-ValkeyV2`, same procedure already
  documented in `bin/ctech-cdk.ts` for the Dragonfly↔Valkey switch.
- HAProxy-side Alpine fragments are opt-in per service repo — no other service
  is forced to change. **ctech-billing is the pilot**, deployed directly to
  prod end-to-end (nginx + app + `send-command` deploy).
- Soak: **1 day** in prod, monitored, before either is treated as done or
  before any other service repo is offered the Alpine fragments.

### 8. Testing

1. `packer validate` plus shellcheck on every new script.
2. Boot the built AMI manually (outside CDK): confirm `rc-status` shows
   `amazon-ssm-agent`/`nginx`/`valkey` running, confirm Session Manager can
   connect, exercise each `ctech-ec2-agent` subcommand individually (an
   `ssm-get` roundtrip, a line appearing in CloudWatch Logs via `logs-tail`, an
   `s3-cp` deploy roundtrip).
3. `df -h` / `free -m` on that instance — resolves the real `rootVolumeGiB` and
   swapfile size (§2).
4. Deploy `ValkeyStackV2` to prod: confirm the SSM URL parameter, the CNAME, and
   that the existing scale-in/out CloudWatch alarms still fire (metric
   namespace is unaffected by the OS change). 1-day soak.
5. Deploy the ctech-billing pilot to prod end-to-end (nginx + app + a real
   `send-command` deploy). 1-day soak.

## Documentation

- This repo's `CLAUDE.md` currently states `DragonflyStack` is instantiated.
  `bin/ctech-cdk.ts` shows `ValkeyStack` active and Dragonfly commented out
  (rolled back — no performance gain on `t4g.nano`, per commit `4ca03db`). This
  is a pre-existing drift, unrelated to this change, corrected in the same pass
  since the surrounding section is being edited anyway.
- `CLAUDE.md` gets new sections: the Packer pipeline, `ctech-ec2-agent` and its
  subcommands, `ValkeyStackV2`, the new SSM paths (§1, §6), the Packer IAM
  role's scope, and a note under "Adding a service" that Alpine fragments are
  available and optional.
- `@aoctech/cdk` release notes flag the new opt-in surface for the five
  consumer repos (`ctech-account`, `ctech-wallet`, `ctech-dfe`, `ctech-poker`,
  `ctech-lbalancer`) — informational, no action required from them.
