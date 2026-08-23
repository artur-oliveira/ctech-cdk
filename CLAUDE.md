# CLAUDE.md — ctech-cdk

Account-level AWS CDK and the published `@aoctech/cdk` package.

## Source of truth

`bin/ctech-cdk.ts` currently instantiates exactly:

- `GlobalStack`: GitHub OIDC provider, `ctech-gha-infra`, global SSM pointers;
- `NetworkStack`: dual-stack/no-NAT VPC, gateway endpoints, shared edge SG, and
  the production private hosted zone;
- `S3Stack`: shared deployments and application-log buckets;
- `ValkeyStack`: shared EC2/ASG cache and pub/sub endpoint (`t4g.nano`),
  publishing `/ctech/{env}/valkey/url` and `cache.internal.aoctech.app`.
  `DragonflyStack` (`lib/dragonfly-stack.ts`) exists but is not instantiated —
  rolled back, no measured performance gain on a `t4g.nano` (commit
  `4ca03db`). Do not re-enable it without re-measuring.
- `Ec2ScriptsStack`: shared EC2 bootstrap scripts published under a content-hash
  prefix, with `/ctech/{env}/ec2-scripts/{bucket,version}` pointers. It also
  publishes the Alpine script library and the `ctech-ec2-agent` binary the
  same way — `/ctech/{env}/ec2-scripts-alpine/{bucket,version}` and
  `/ctech/{env}/ctech-ec2-agent/{bucket,version}`.

`lib/valkey-stack-v2.ts` (`ValkeyStackV2`) exists but is not instantiated —
staged in `bin/ctech-cdk.ts`, commented out, pending the prod cutover in
`docs/plans/2026-08-23-alpine-ec2-ami.md` Task 13. It is the Alpine/OpenRC
equivalent of `ValkeyStack`, booting from an AMI resolved from
`/ctech/{env}/ami/alpine/arm64` instead of Amazon Linux 2023. Same external
contract (`/ctech/{env}/valkey/url`, `cache.internal.aoctech.app`) — the two
cannot coexist in one environment.

There is no deployed `AlbStack`. Public and private ingress is owned by
`ctech-lbalancer`. `lib/alb-stack.ts`, `SSM.alb()`, and
`PrivateIpv4Ec2Service` are legacy compatibility surfaces, not templates for
new services.

The compatibility path `/ctech/{env}/network/alb-sg-id` now identifies the
shared edge SG. Never rename it without coordinating ctech-lbalancer and all
service CDKs.

## Mandatory workflow

1. Read `lib/constants.ts`, `lib/index.ts`, and the relevant stack.
2. Search consumers before changing an exported symbol or SSM path.
3. Reuse an existing current pattern before creating a construct.
4. Implement the smallest compatible change.
5. Run `npm test`, `npx tsc --noEmit`, and an appropriate CDK synth.
6. Inspect IAM and security-group changes in the synthesized template.
7. Update documentation in the same change.
8. Report cross-repository impact and suggest a Conventional Commit.

## Scope

Shared/account-level resources belong here. Service tables, service-specific
Lambdas, API ASGs, frontend buckets, and business alarms belong in the service
repository.

A future reusable HAProxy service construct may own the common service-ASG
shape, route SSM manifest, logs, health/scaling defaults, and edge-SG ingress.
It must not own service-specific IAM, secrets, ports, or business alarms.

## Contracts

- SSM paths live in `lib/constants.ts`; `SSM` is exported from
  `lib/index.ts`. Includes `SSM.amiAlpine(env).arm64`,
  `SSM.ec2ScriptsAlpine(env).{bucket,version}`, and
  `SSM.ctechEc2Agent(env).{bucket,version}` — see "Alpine AMI pipeline".
- Renaming/removing an SSM path is a cross-repository breaking change.
- `Vpc.fromLookup` needs a concrete VPC ID at synth time; workflows normally
  read it from SSM into `CTECH_VPC_ID`.
- Shared S3 access must be scoped to a service prefix.
- The production private zone is `internal.aoctech.app` and is associated
  with the production VPC. Other VPCs require an explicit association.
- The shared edge SG allows production private IPv4 HTTPS from the VPC and
  public IPv6 HTTPS; ctech-lbalancer further restricts public traffic with
  nftables and Authenticated Origin Pull mTLS.

## Published package

Current public exports:

- `Environment`, `SSMParams`;
- `SSM`, `DEFAULT_AWS_ACCOUNT`, `DEFAULT_AWS_REGION`;
- `GithubActionsDeployRoles`, props, and `githubTrustPrincipal`;
- deprecated `PrivateIpv4Ec2Service`;
- shared EC2 user-data fragments (AL2023) and their Alpine/OpenRC equivalents
  (`addDualStackSsmAgentCommandsAlpine`, `addCloudflareOriginCaCommandsAlpine`);
- `Ec2ScriptRunner` and props;
- `AsgScheduleProps`, `DEFAULT_ASG_SCHEDULE`, `addAsgSchedule`.

`addCloudflareOriginCaCommands` downloads the official Cloudflare Origin CA
RSA root, verifies its pinned SHA-256 and installs it in the Amazon Linux trust
store. EC2 clients must apply it before calling `*.internal.aoctech.app`;
never disable TLS verification.

Shared EC2 user-data fragments (`addSwapCommands` and the rest) are superseded by
`assets/ec2/*.sh` plus `Ec2ScriptRunner`. They remain exported until every
service repository has migrated, then are removed in 1.0.0 alongside
`PrivateIpv4Ec2Service`. Do not add new consumers.

Do not add new consumers of `PrivateIpv4Ec2Service`: it creates ALB target
groups and listener rules. Preserve it until existing compatibility needs have
been verified and a major-version removal is planned.

## Security

- GitHub Actions uses OIDC, not long-lived AWS access keys.
- `ctech-gha-infra` currently has `AdministratorAccess` because it deploys
  broad account-level CDK resources. Do not reuse it for application deploys.
- `ctech-gha-packer` is scoped to EC2 image-build actions only (see "Alpine
  AMI pipeline") — never grant it `AdministratorAccess` or broader.
- Keep service deploy roles separate by responsibility where possible.
- Public services have no public IPv4 and the VPC has no NAT Gateway.
- Never commit AWS credentials, certificate material, Cloudflare tokens, or
  customer data.
- Review every wildcard IAM permission. Some AWS read/list/control-plane
  actions do not support resource-level scoping; document those cases.

## Cost and resilience

- No NAT Gateways.
- S3/DynamoDB gateway endpoints are shared and free of hourly endpoint cost.
- Dragonfly is a size-one `t4g.nano` ASG without persistence. Treat it as
  ephemeral cache/pub-sub and account for replacement outages. Its flags are
  sized for 512 MiB of RAM; see README before changing `--maxmemory`,
  `--proactor_threads` or `--dbnum`.
- `ValkeyStack` is the active cache stack; `lib/dragonfly-stack.ts` is not
  instantiated. Deploying Dragonfly in an environment again would require
  deleting the Valkey stack there first (not currently planned — see
  "Source of truth").
- The deployments bucket expires objects after 30 days.
- The application-log archive bucket is retained and has no expiration; any
  lifecycle change requires a retention decision.
- Do not consolidate services or downsize instances from CPU data alone.
  Memory, connections, boot headroom, and failure blast radius are required.

## Adding a service

A service CDK should:

1. import the VPC and shared edge SG;
2. create an independent service role, SG, ASG, logs, health endpoint, and
   scaling policy;
3. allow only its application port from the edge SG;
4. publish `/ctech/{env}/lbalancer/routes/{service}`;
5. create the appropriate private CNAME;
6. scope S3 permissions to its prefix;
7. use separate OIDC deployment roles and validate with synth.

No listener priority or ALB rule is required.

An Alpine/OpenRC EC2 base is available and optional: `lib/ec2-userdata-fragments-alpine.ts`
for CDK callers (import instead of `ec2-userdata-fragments.ts` — `addSwapCommands`
is shared, unchanged, and not duplicated), or `assets/ec2-alpine/*.sh` composed
directly for Terraform callers (`ctech-billing`, `ctech-lbalancer`), same
positional-argument contract as their `assets/ec2/*.sh` counterparts. Nothing
requires a service to migrate; AL2023 stays fully supported.

## Alpine AMI pipeline (staged)

A Packer pipeline builds a custom Alpine ARM64 AMI, meant to eventually replace
AL2023 minimal on new EC2 launch templates at a fraction of the root volume
size (target `rootVolumeGiB: 1`, see the spec for the disk budget). Not yet
consumed by any deployed stack — `ValkeyStackV2` is the first consumer, staged
but commented out in `bin/ctech-cdk.ts`.

- `packer/alpine-arm64.pkr.hcl`: builds from Alpine's official AWS cloud image
  (owner `538276064493`), installs `amazon-ssm-agent`/`amazon-ssm-agent-openrc`,
  `curl`, and the `ctech-ec2-agent` binary, nothing else. Session Manager access
  and `send-command` deploys both depend on `amazon-ssm-agent` — never drop it.
  Also bakes in `/etc/init.d/ctech-userdata` (`packer/files/ctech-userdata`),
  enabled in the default runlevel: this Alpine cloud image's cloud-init never
  executes EC2 user-data (confirmed live 2026-08-23 — `modules:final` completes
  in well under a second with no package installs or script output), so this
  OpenRC service fetches user-data from IMDS and runs it directly instead. Every
  Alpine consumer's `ec2.UserData` therefore only actually runs via this
  service, not via cloud-init's `scripts-user` module.
- `.github/workflows/build-alpine-ami.yml` (`workflow_dispatch`): resolves the
  `ctech-ec2-agent` build for the chosen environment from SSM, runs
  `packer build`, publishes the resulting AMI id to
  `/ctech/{env}/ami/alpine/arm64`. Consumers resolve that parameter via
  `ec2.MachineImage.fromSsmParameter` — a rebuilt AMI only takes effect on a
  consumer's next `cdk deploy`, same as an `ec2-scripts` change.
- Runs under `ctech-gha-packer`, a dedicated OIDC role (`lib/global-stack.ts`)
  scoped to EC2 image-build/run/describe actions plus read access to the
  `ctech-ec2-agent` SSM paths and its S3 prefix. Never `ctech-gha-infra`
  (`AdministratorAccess`) — Packer's `amazon-ebs` builder does not support
  resource-level scoping for most of its EC2 control-plane calls, so this role
  is broad within EC2 but touches nothing outside it.
- `ctech-ec2-agent` (`assets/ctech-ec2-agent/`, Go, `CGO_ENABLED=0`,
  `GOOS=linux GOARCH=arm64`) replaces both `aws-cli` and the CloudWatch Agent
  on the Alpine image — neither has a working Alpine/musl package. Built by CI
  (`.github/workflows/ctech-cdk.yml`) before every `cdk diff`/`cdk deploy`,
  since `Ec2ScriptsStack` hashes its `dist/` output as an S3 asset. Subcommands:
  `ssm-get`, `ssm-put`, `prefix-list`, `route53-upsert`, `s3-cp`, `s3-head`,
  `logs-tail` (the one genuinely new piece — tails files, survives log
  rotation by inode, batches, ships to CloudWatch Logs; no metrics, per the
  spec's non-goals).

## Documentation policy

Every behavioral, architectural, configuration, deployment, security, or
developer-workflow change must update the corresponding documentation in the
same change.
