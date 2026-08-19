# ctech-cdk

AWS CDK (TypeScript) for shared, account-level CTech infrastructure and the
`@aoctech/cdk` package used by service CDKs.

The deployed platform owns the dual-stack VPC, GitHub Actions OIDC provider,
shared S3 buckets, the production private hosted zone, and the shared Dragonfly
cache. Public and private API ingress is provided by
[ctech-lbalancer](https://github.com/artur-oliveira/ctech-lbalancer), not by an
AWS Application Load Balancer.

## Current architecture

```text
Ctech-Global
  ├── GitHub Actions OIDC provider
  ├── ctech-gha-infra role
  └── global SSM pointers (OIDC provider and ACM certificate)

Ctech-{Env}-Network
  ├── dual-stack VPC across up to two AZs, no NAT Gateway
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

Ctech-{Env}-Dragonfly
  ├── DragonflyDB on an EC2 Auto Scaling Group, t4g.nano
  ├── desired/min/max = 1/1/1 in every environment
  ├── nightly schedule takes it to zero 22:00-10:00 BRT
  └── cache.internal.aoctech.app + /ctech/{env}/valkey/url
```

Only `GlobalStack`, `NetworkStack`, `S3Stack`, `Ec2ScriptsStack`, and
`DragonflyStack` are instantiated by `bin/ctech-cdk.ts`. `lib/alb-stack.ts` and
`PrivateIpv4Ec2Service` are retained as legacy migration code; neither
represents the current production ingress architecture.

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
| `/ctech/{env}/valkey/url` | Cache base URL (now Dragonfly); consumers append their DB number |
| `/ctech/{env}/ec2-scripts/bucket` | Bucket holding the shared EC2 bootstrap scripts |
| `/ctech/{env}/ec2-scripts/version` | Content hash of `assets/ec2`, and the S3 key prefix the scripts live under |

`SSM.alb(env)` remains exported for compatibility with legacy ALB code, but
the current entrypoint does not deploy `AlbStack` and therefore does not write
`/ctech/{env}/alb/*`.

## npm package

```bash
npm install @aoctech/cdk
```

Source version 0.3.0 exports from `lib/index.ts`:

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
  route-registration pattern;
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

### Releasing

1. Land a green change on `main`.
2. Bump `package.json` using semver.
3. Create release/tag `vX.Y.Z` (the next release is `v0.3.0`).
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

## Shared cache (Dragonfly)

`DragonflyStack` replaces `ValkeyStack` and deliberately keeps its contract:
the same `/ctech/{env}/valkey/url` parameter and the same
`cache.internal.aoctech.app` record, so no service repository changes. The two
stacks own the same parameter and the same record and cannot coexist. Cut over
one environment at a time:

```bash
aws cloudformation delete-stack --stack-name Ctech-{Env}-Valkey
ENVIRONMENT={env} npx cdk deploy Ctech-{Env}-Dragonfly
```

The cache is empty on both sides of that gap by design. `lib/valkey-stack.ts`
is kept only so the previous template can still be read; nothing instantiates
it.

The binary is the official `dragonfly-aarch64` release, downloaded and verified
against a SHA-256 pinned in `assets/dragonfly/install.sh` and republished as a
CDK asset — the instance has no NAT and no public IPv4, so it can only fetch
from S3. Version and digest live in that script rather than in TypeScript
because the asset hash is the hash of the directory: editing the script is what
invalidates the S3 object and versions the launch template.

`install.sh` only downloads and verifies, so bundling runs directly on the synth
host through CDK's `local` hook - the CI runner (`ubuntu-slim`) has no Docker
daemon. The `amazonlinux:2023` container stays as the fallback for a host without
`curl` or `tar`. When run locally the script honours `ASSET_OUTPUT_DIR`.

Flag choices are driven by the 512 MiB t4g.nano:

| Flag | Value | Why |
| --- | --- | --- |
| `--maxmemory` | `256mb` | Hard floor, not a sizing choice: Dragonfly exits with `There are 1 threads, so 256.00MiB are required` below 256 MiB per proactor thread. Dataset cap, not process RSS |
| `--rss_oom_deny_ratio` | `0.7` | Denies OOM-prone writes at ~180 MiB RSS. The 1.25 default assumes a host sized for `--maxmemory`; on a 512 MiB nano it would feed the OOM killer |
| `--proactor_threads` | `1` | Default is one per core; a second thread on a nano only buys a second set of arenas |
| `--dbnum` | `8` | `/0` cache, `/1` ws pub/sub, `/2+` per service |
| `--dbfilename` | empty | Disables the shutdown snapshot on a cache that is scaled to zero nightly |
| `--cache_mode` | `true` | Evicts under pressure instead of failing writes; matches the previous `allkeys-lru` |
| `--publish_buffer_limit` | `16mb` | Default is 196 MB per IO thread, and the hard limit is 4x the soft one |
| `--pipeline_buffer_limit` | `32mb` | Default is 128 MB per IO thread |
| `--pubsub_slow_subscriber_timeout_ms` | `5000` | Off by default; drops a subscriber that stopped draining instead of parking every publisher |

Pub/Sub buffers are process memory and are **not** counted against
`--maxmemory`. `ctech-go-common/ws` holds one `PSUBSCRIBE` connection per API
instance (ctech-dfe websockets), so a single slow consumer is enough to reach
those limits. It resubscribes on close, at the cost of the messages published
during the gap - Pub/Sub is fire-and-forget either way.

`--cache_mode` does not affect Pub/Sub: messages are not keyspace entries, and
`PUBLISH` is not an OOM-denied command. It only decides what happens to keys at
the cap - eviction, versus every write failing, including the wallet `SETNX`
lock. On this box the binding limit is `--rss_oom_deny_ratio`, not the 256 MiB
dataset cap: the real working set is around 64 MiB, so eviction at 256 MiB would
never fire before the host ran out of RAM.

The instance also gets 512 MiB of swap through `setup-swap.sh`. Without it the
OOM killer picks the largest RSS — Dragonfly — and `Restart=always` brings it
back empty, which presents as a healthy cache that silently lost everything.

A boot that never gets a `PONG` within 60 seconds calls
`autoscaling:SetInstanceHealth` on itself: the ASG health check is EC2-level
and would otherwise keep an empty instance serving the DNS record. There is no
scale-from-zero policy, because that needs a metric published while the cache
is down and nothing in the organisation publishes one.

## Cost and resilience constraints

- The VPC has zero NAT Gateways; workloads use IPv6 and free gateway endpoints.
- Dragonfly intentionally remains one `t4g.nano` instance with no persistence
  (`--dbfilename=`). It is a cache/pub-sub service, not a durable store.
  Clustering/sharding is deferred because its operational complexity and extra
  compute are not justified by the present traffic or SLO.
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

Do not add service-specific tables, Lambdas, or buckets to this repository.
