# ctech-cdk

AWS CDK (TypeScript) for shared, account-level CTech infrastructure and the
`@aoctech/cdk` package used by service CDKs.

The deployed platform owns the dual-stack VPC, GitHub Actions OIDC provider,
shared S3 buckets, the production private hosted zone, and the shared Valkey
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

Ctech-{Env}-Valkey
  ├── Valkey on an EC2 Auto Scaling Group
  ├── prod desired/min/max = 1/1/1
  ├── non-prod can scale to zero
  └── cache.internal.aoctech.app + /ctech/{env}/valkey/url
```

Only `GlobalStack`, `NetworkStack`, `S3Stack`, and `ValkeyStack` are
instantiated by `bin/ctech-cdk.ts`. `lib/alb-stack.ts` and
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
| `/ctech/{env}/valkey/url` | Valkey base URL; consumers append their DB number |

`SSM.alb(env)` remains exported for compatibility with legacy ALB code, but
the current entrypoint does not deploy `AlbStack` and therefore does not write
`/ctech/{env}/alb/*`.

## npm package

```bash
npm install @aoctech/cdk
```

Source version 0.2.0 exports from `lib/index.ts`:

- `Environment`, `SSMParams`;
- `SSM`, `DEFAULT_AWS_ACCOUNT`, `DEFAULT_AWS_REGION`;
- `GithubActionsDeployRoles`, its props, and `githubTrustPrincipal`;
- the deprecated `PrivateIpv4Ec2Service`;
- EC2 user-data fragments for dual-stack SSM, CloudWatch, swap, and real-IP
  refresh;
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
3. Create release/tag `vX.Y.Z` (the next release is `v0.2.0`).
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

## Cost and resilience constraints

- The VPC has zero NAT Gateways; workloads use IPv6 and free gateway endpoints.
- Production Valkey intentionally remains one `t4g.micro` instance with no persistence
  (`save ""`, `appendonly no`). It is a cache/pub-sub service, not a durable
  store. Clustering/sharding is deferred because its operational complexity and
  extra compute are not justified by the present traffic or SLO.
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
3. Use `HaproxyEc2Service` for its ASG, logs, SG, scaling and validated route
   manifest; allow only the service port from the shared edge SG.
4. Create the private DNS alias only where the hosted zone is associated.
5. Use `buildCloudWatchAgentConfig` and scope deployment/log bucket access to the
   service prefix.
6. Use `createNextjsStaticFrontend` for the static SPA and add only genuinely
   service-specific behaviours through its callback.
7. Use OIDC roles separated by API, frontend, and infrastructure duties.
8. Run tests, TypeScript compilation, and CDK synth before deployment.

Do not add service-specific tables, Lambdas, or buckets to this repository.
