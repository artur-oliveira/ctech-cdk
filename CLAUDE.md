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
  prefix, with `/ctech/{env}/ec2-scripts/{bucket,version}` pointers.

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
  `lib/index.ts`.
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
- shared EC2 user-data fragments;
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
- `lib/valkey-stack.ts` is no longer instantiated. Deleting the Valkey stack
  in an environment is the prerequisite for deploying Dragonfly there.
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

## Documentation policy

Every behavioral, architectural, configuration, deployment, security, or
developer-workflow change must update the corresponding documentation in the
same change.
