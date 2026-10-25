## EC2 capacity (2026-10-01)

The active Valkey user data carries the capacity configuration to version its launch template and force rolling replacement of pre-existing Spot hosts during migration. Merely switching ASG policies leaves existing instances running.

The active ValkeyV2 stack uses only `t4g.nano` On-Demand capacity. `HaproxyEc2Service` 0.10.0 accepts `onDemand: true`, emits a direct launch template without MixedInstancesPolicy, and disables capacity rebalance. Combining `onDemand` and `spot` is rejected. Existing callers retain their Spot defaults; billing and dfe are not migrated. EC2 Instance Savings Plans are purchased separately and apply automatically to eligible usage in the selected family and region. Historical Spot notes below are superseded.

# ctech-cdk

AWS CDK (TypeScript) for shared, account-level CTech infrastructure and the
`@aoctech/cdk` package used by service CDKs.

This is a shared foundation library consumed by every CTech service — treat every change here (defaults, IAM,
health checks, ASG/spot behavior, DynamoDB billing caps) as a cross-repo contract change, not a local tweak.
Confirmed consumers today: `ctech-account/cdk`, `ctech-wallet/cdk`, `ctech-dfe/cdk`, `ctech-poker/cdk` (pinned `0.10.2`;
`ctech-dfe` `^0.10.2`). `ctech-billing` does not consume this package (Terraform).

The deployed platform owns the dual-stack VPC, GitHub Actions OIDC provider,
shared S3 buckets, the production private hosted zone, and the shared Valkey
cache (`ValkeyStackV2`). Public and private API ingress is provided by
[ctech-lbalancer](https://github.com/artur-oliveira/ctech-lbalancer), not by an
AWS Application Load Balancer.

## Current architecture

```text
Ctech-Global
  ├── GitHub Actions OIDC provider
  ├── ctech-gha-infra role
  └── global SSM pointers (OIDC provider and ACM certificate)

Ctech-{Env}-Network
  ├── dual-stack VPC across all six pinned us-east-1 AZs, no NAT Gateway
  ├── S3 and DynamoDB gateway endpoints
  ├── shared edge security-group identity
  ├── production-only private zone: internal.aoctech.app
  └── network/private-zone SSM parameters

Ctech-{Env}-S3
  ├── {env}-ctech-deployments (30-day lifecycle)
  └── {env}-ctech-application-logs
      ├── objects >128 KiB → Glacier Flexible Retrieval after 90 days
      └── all objects expire after 400 days; bucket remains retained

Ctech-{Env}-Ec2Scripts
  ├── {env}-ctech-ec2-scripts, objects under a content-hash prefix
  └── /ctech/{env}/ec2-scripts/{bucket,version}

Ctech-{Env}-ValkeyV2
  ├── ValkeyStackV2 (Alpine/OpenRC) on an EC2 Auto Scaling Group, t4g.nano On-Demand
  ├── desired/min/max = 1/1/1 in every environment
  ├── boots from an AMI resolved from /ctech/{env}/ami/alpine/arm64
  └── cache.internal.aoctech.app + /ctech/{env}/valkey/url
```

Only `GlobalStack`, `NetworkStack`, `S3Stack`, `Ec2ScriptsStack`,
`AlertsStack` (conditional on `ALERT_EMAIL`), and `ValkeyStackV2` are
instantiated by `bin/ctech-cdk.ts`. `lib/alb-stack.ts` and
`PrivateIpv4Ec2Service` are retained as legacy migration code; neither
represents the current production ingress architecture. The original `lib/valkey-stack.ts` also exists but is **not** instantiated
(commented out in `bin/ctech-cdk.ts`); it was superseded by `ValkeyStackV2`. Only one cache stack may be instantiated per
environment; see `CLAUDE.md` "Source of truth" before touching any of them.

The SSM path `/ctech/{env}/network/alb-sg-id` and the physical security-group
name retain `alb` for compatibility. The resource is now the shared edge SG
identity attached to ctech-lbalancer and trusted by service SGs. Renaming it
requires a coordinated migration across every service.

## Traffic and discovery

```text
public:  client → Cloudflare → origin.aoctech.app AAAA → HAProxy → service private IPv4
private: service → *.internal.aoctech.app → HAProxy private IPv4 → service private IPv4
```

The current four bootstrap route parameters and private aliases are owned by
`ctech-lbalancer`. Each service CDK owns:

- its API ASG and service security group;
- its CloudFront/S3 frontend and public API hostname configuration.

For a new service, `HaproxyEc2Service` can also own its SSM Standard route under
`/ctech/{env}/lbalancer/routes/{service}` and its private CNAME to
`lbalancer.internal.aoctech.app`. Existing bootstrap routes must not be created
from a second stack until CloudFormation ownership is explicitly transferred.

ctech-lbalancer reconciles route manifests every 30 seconds, discovers healthy
`InService` instances, reloads HAProxy only after validating the generated
configuration, and updates the Cloudflare origin AAAA record.

## SSM parameters written by deployed stacks

| Path | Description |
|---|---|
| `/ctech/global/oidc/provider-arn` | Shared GitHub OIDC provider ARN |
| `/ctech/global/acm/cert-arn` | Wildcard `*.aoctech.app` ACM certificate ARN |
| `/ctech/global/dns/private-hosted-zone-id` | Production-owned private zone ID |
| `/ctech/global/dns/private-hosted-zone-name` | `internal.aoctech.app` |
| `/ctech/{env}/network/vpc-id` | Shared VPC ID |
| `/ctech/{env}/network/alb-sg-id` | Compatibility name for the shared edge SG |
| `/ctech/{env}/s3/deployments-bucket` | Shared deployment-artifact bucket |
| `/ctech/{env}/s3/logs-bucket` | Shared application-log archive bucket |
| `/ctech/{env}/valkey/url` | Cache base URL (Valkey, `ValkeyStackV2`); consumers append their DB number |
| `/ctech/{env}/ec2-scripts/bucket` | Bucket holding the shared EC2 bootstrap scripts |
| `/ctech/{env}/ec2-scripts/version` | Content hash of `assets/ec2`, and the S3 key prefix the scripts live under |
| `/ctech/{env}/alerts/topic-arn` | Shared alert topic every service publishes its own failures to |

`SSM.alb(env)` remains exported for compatibility with legacy ALB code, but
the current entrypoint does not deploy `AlbStack` and therefore does not write
`/ctech/{env}/alb/*`.

## npm package

```bash
npm install @aoctech/cdk
```

Source version 0.10.2 exports from `lib/index.ts`:

- `Environment`, `SSMParams`;
- `SSM`, `DEFAULT_AWS_ACCOUNT`, `DEFAULT_AWS_REGION`;
- `GithubActionsDeployRoles`, its props, and `githubTrustPrincipal`;
- the deprecated `PrivateIpv4Ec2Service`;
- EC2 user-data fragments for dual-stack SSM, CloudWatch, swap, real-IP
  refresh, and Cloudflare Origin CA trust (superseded by `assets/ec2/*.sh`);
- `Ec2ScriptRunner`, which emits user data that downloads and runs the shared
  bootstrap scripts;
- `AsgScheduleProps`, `DEFAULT_ASG_SCHEDULE` and `addAsgSchedule` for the
  nightly ASG stop/start pair;
- `HaproxyEc2Service`, the current private-IPv4 + IPv6 ASG, edge-SG and optional
  route-registration pattern, with `spot.instanceTypes` for diversifying Spot
  capacity across compatible instance types, and an opt-in `terminationDrain`
  for a graceful spot-interruption/scale-in window;
- `buildCloudWatchAgentConfig`, with a bounded four-series host/process metric
  set;
- `createNextjsStaticFrontend`, which centralizes the repeated S3 + OAC + KVS +
  CloudFront + CSP + API-origin pattern while accepting service-specific
  behaviours and rewrite code.

Do not build new services on `PrivateIpv4Ec2Service`, because it creates an ALB
target group and listener rule. `createNextjsStaticFrontend` deliberately adds
resources directly to the supplied stack with the established IDs (`Bucket`,
`OAC`, `RouteStore`, `UrlRewrite`, `SecurityHeaders`, `Distribution`), allowing
an existing frontend stack to migrate without changing logical IDs. Always
prove that with a template diff before deployment; Wallet's locale rewrite,
DFE's docs CSP and Poker's avatar behaviour use the documented escape hatches.

Diversify a service across compatible Spot pools through the Spot
configuration. The launch template's `instanceType` remains the fallback when
this list is omitted:

```ts
spot: {
  instanceTypes: [
    new ec2.InstanceType('t4g.nano'),
    new ec2.InstanceType('t4g.micro'),
  ],
},
```

Opt into a graceful termination drain (spot reclaim, scale-in, instance
refresh) with `terminationDrain`. Omitting it keeps today's behavior —
instances terminate immediately, with no warning to in-flight work:

```ts
terminationDrain: {
  enabled: true,
  drainCommand: 'rc-service app stop; rc-service app2 stop', // or `systemctl stop app app2` on AL2023
  timeoutSeconds: 150, // default; the bounded window before AWS proceeds regardless
},
```

This wires an ASG lifecycle hook (`EC2_INSTANCE_TERMINATING`) to a Lambda that
runs `drainCommand` via SSM RunCommand and then calls
`CompleteLifecycleAction` — on success or once its own bounded wait elapses,
so a stuck SSM agent can never strand an instance in `Terminating:Wait`. Stop
the app process in `drainCommand`: HAProxy's existing health poll then starts
failing and traffic drains away on its own, with no separate deregistration
call needed. `ctech-poker`'s API stack has a hand-rolled version of this same
pattern locally (`cdk/lib/api-stack.ts`); it should migrate to this prop once
this ships, rather than keeping two copies in the family.

### Releasing

1. Land a green change on `main`.
2. Bump `package.json` using semver.
3. Create release/tag `vX.Y.Z` matching the bumped `package.json` version (latest tag is `v0.10.2`; consumers pin `0.10.2`/`^0.10.2`).
4. `.github/workflows/publish.yml` publishes with npm trusted publishing and
   provenance; no `NPM_TOKEN` is stored.
5. Upgrade consumers deliberately and run their synths.

## Deployment

Prerequisites: Node.js 24, a bootstrapped CDK account, and AWS credentials with
the required infrastructure permissions.

```bash
npm ci
npm run build
ENVIRONMENT=prod npx cdk synth
ENVIRONMENT=prod npx cdk diff --all
ENVIRONMENT=prod npx cdk deploy --all --require-approval never
```

The initial `Ctech-Global` deployment must be performed with credentials that
can create the OIDC provider and `ctech-gha-infra` role. Later GitHub Actions
deploys use OIDC rather than long-lived AWS keys.

| Variable | Default | Purpose |
|---|---|---|
| `ENVIRONMENT` | `dev` | `dev`, `stage`, or `prod` |
| `AWS_ACCOUNT` | account constant | Target AWS account |
| `AWS_REGION` | `us-east-1` | Target region |
| `AWS_CERTIFICATE_ARN` | constant | Wildcard ACM certificate |
| `GITHUB_REPO` | `artur-oliveira/ctech-cdk` | Repository trusted by the infra role |

Branch-to-environment behavior is defined by the workflow, not by the CDK
entrypoint. Inspect the workflow before assuming a branch mapping.

### Service URL parameters

After the private zone and ctech-lbalancer aliases exist, seed the non-secret
runtime URLs before replacing service instances:

```bash
CTECH_AWS_PROFILE=ctech ./scripts/configure-service-url-parameters.sh prod
```

The command creates transport-only internal account/JWKS URLs, each service's
private base URL, the public audience/browser URLs, Poker's public avatar base
URL, and Poker's private Wallet URL. It deliberately does not overwrite ctech-account's existing
`base-url`/`app-url`: those values participate in OAuth issuer and redirect
contracts and must remain public. Dev/stage private URLs require their VPC to
be associated with the private hosted zone before use.

## Alerts

Policy: CDK is frozen (no new constructs; Terraform is the future). Alerts go only through this SNS topic; no
custom CloudWatch metrics and no CloudWatch alarms. `@aoctech/ui` should absorb what products copied locally
(ctech-billing `docs/specs/2026-10-17-ui-upstream-proposals.md`).

One SNS topic per environment, `ctech-{env}-alerts`, with a single confirmed
e-mail subscription. Every service publishes its own failures to it through
`gopkg.aoctech.app/api-commons/alerts`, reading the ARN from
`/ctech/{env}/alerts/topic-arn`.

Deliberately not CloudWatch: an alarm is billed per alarm per month and the
family would need dozens of them to say the one thing that matters — "this job
did not do its work" — which every job already knows at the moment it happens.
SNS e-mail is free for the first thousand notifications a month, well past the
volume at which anybody would stop reading them.

What it does not buy is liveness. A process that never runs publishes nothing,
and silence here reads exactly like health, so a service that needs "did it run
at all" has to assert it from the next run rather than from a metric.

```bash
ALERT_EMAIL=you@example.com ENVIRONMENT={env} npx cdk deploy Ctech-{Env}-Alerts
```

The stack is skipped entirely when `ALERT_EMAIL` is unset — an address baked
into source is one nobody notices is wrong. AWS sends a confirmation e-mail on
first deploy and the subscription delivers nothing until it is accepted.

## Cost and resilience constraints

- The VPC has zero NAT Gateways; workloads use IPv6 and free gateway endpoints.
- Production LBalancer intentionally remains one instance because Cloudflare's
  origin is one IPv6 address. Multiple nodes require a separate multi-origin or
  balancing strategy and would add cost without a demonstrated availability
  need. Service ASGs also keep one baseline instance and retain max 3 where
  configured; this decision should be revisited only from measured SLO/traffic.
- `internal.aoctech.app` is created only by the production network stack.
  Enabling private M2M for another VPC requires explicitly associating that VPC
  with the existing zone.
- Shared application-log objects have a 400-day retention. Archives over 128
  KiB transition to Glacier after 90 days; smaller daily archives stay Standard
  because archival minimum billable sizes can cost more than the storage saved.
- `ctech-gha-infra` has `AdministratorAccess` for broad CDK deployments.
  It is protected by GitHub OIDC, but reducing its blast radius remains a
  worthwhile hardening project.

## Adding a service

1. Read the shared VPC and edge-SG IDs from SSM/CI.
2. Create an independent service IAM role, health endpoint and service-specific
   user data.
3. Add `addCloudflareOriginCaCommands(userData)` before starting a client that
   calls `*.internal.aoctech.app`; it downloads only the official Cloudflare
   Origin CA RSA root, verifies its pinned SHA-256 and X.509 validity, then runs
   `update-ca-trust extract`.
4. Use `HaproxyEc2Service` for its ASG, logs, SG, scaling and validated route
   manifest; allow only the service port from the shared edge SG.
5. Create the private DNS alias only where the hosted zone is associated.
6. Use `buildCloudWatchAgentConfig` and scope deployment/log bucket access to the
   service prefix.
7. Use `createNextjsStaticFrontend` for the static SPA and add only genuinely
   service-specific behaviours through its callback.
8. Use OIDC roles separated by API, frontend, and infrastructure duties.
9. Run tests, TypeScript compilation, and CDK synth before deployment.

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
names, the CloudWatch agent JSON, and `/etc/app-static.env`. Per-service derived
environment variables go in `/opt/app/service-env.sh`. `setup-nginx.sh` has three
extension points, all optional:

| File | Included in | Use for |
|---|---|---|
| `/etc/nginx/conf.d/http-*.conf` | `http {}` | extra `limit_req_zone`, `map`, gzip overrides |
| `/etc/nginx/conf.d/location-*.conf` | `server {}` | extra `location` blocks |
| `/etc/nginx/conf.d/proxy-*.conf` | `location / {}` | extra `limit_req` / `limit_conn` on the catch-all |

The scripts themselves live in `assets/ec2/` in this repository. Editing one
changes the asset hash, which changes every consuming service's user data on its
next deploy — that is what triggers the instance refresh, and it means a script
change is a cross-repository change.

`HaproxyEc2Service` attaches a CloudFormation `AutoScalingRollingUpdate` policy to
every ASG (On-Demand and Spot, since 0.10.1), so any launch template change, such
as a new `/etc/app-static.env` variable, replaces running instances one at a time
during `cdk deploy`. Before 0.10.1 Spot ASGs kept their old instances, and the next
`deploy-backend` run started a new binary against the stale env file.
`MinInstancesInService` is `minCapacity` capped at `maxCapacity - 1`, because
CloudFormation rejects a value that leaves no room for the replacement.

The `deploy-backend` action polls each SSM invocation until it reaches a terminal
status, for up to `timeout-seconds` (also the SSM `executionTimeout`) plus a 60s
delivery margin, and prints the command's stdout and stderr on failure. It no longer
uses `aws ssm wait command-executed`, which gave up after about 100 seconds and
reported a still-running deploy as `InProgress`.

#### Zero-downtime rolling deploy on a single instance

By default `deploy.sh` restarts one `app` process, so a deploy has a brief gap
while it comes back up. A service can opt into a second process on an
alternate port instead — nginx round-robins across both, and `deploy.sh` rolls
them one at a time so the instance keeps serving throughout:

```ts
scripts.run(userData, 'setup-nginx.sh', '8080', '8000', '/v1.0/health-check', '100', '1m', '8001');
scripts.run(userData, 'setup-app-service.sh', 'CTech Example API', 'app', 'network.target nginx.service', '8001');
scripts.run(userData, 'setup-deploy.sh', deploymentsBucketName, 'app', 'http://127.0.0.1:8000/v1.0/health-check');
```

`setup-deploy.sh` needs no change to opt in — it detects the alt port from
`/opt/app/alt-port`, written by `setup-app-service.sh`. Omitting the alt-port
argument on both calls (the existing behavior of every current service) keeps
the traditional single-process restart. The trade-off is a permanently
resident second process (RAM, always-on) in exchange for no restart gap;
skip it on memory-constrained instances that can tolerate the few-second blip.

Do not add service-specific tables, Lambdas, or buckets to this repository.
