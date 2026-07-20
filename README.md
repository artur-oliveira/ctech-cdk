# ctech-cdk

AWS CDK (TypeScript) for account-level shared infrastructure. Owns the VPC, shared ALB, and GitHub Actions OIDC deploy role used by all CTech services. Service CDKs (py-dfe-cdk, etc.) consume these resources via SSM Parameter Store - they never depend on this repo's CloudFormation stacks directly.

This repo is also published to npm as **[`@aoctech/cdk`](https://www.npmjs.com/package/@aoctech/cdk)** — a small library of constructs shared across service CDKs, starting with `PrivateIpv4Ec2Service` (the private-IPv4-only, no-NAT-Gateway EC2/ASG pattern every service behind the shared ALB uses). See `lib/index.ts` for the full export list. This is a separate concern from the stacks below: the stacks deploy *this account's* shared infra; the npm package is *code* every service's own CDK imports.

```bash
npm install @aoctech/cdk
```

```typescript
import {PrivateIpv4Ec2Service, addRealipRefreshCommands} from '@aoctech/cdk';
```

### Releasing `@aoctech/cdk`

1. Land changes on `main` — CI must be green.
2. Bump `version` in `package.json` per [semver](https://semver.org/).
3. Create a GitHub Release (tag `vX.Y.Z`) — `.github/workflows/publish.yml` builds `dist/` and runs
   `npm publish --provenance` via npm's OIDC trusted publishing (no `NPM_TOKEN` stored in this repo).
4. Bump the dependency in consumers (`ctech-account/cdk`, `ctech-dfe/cdk`, `ctech-wallet/cdk`) on
   their own schedule.

---

## Architecture

```
Ctech-Global                     (one per account, deployed once)
  └── IAM Role: ctech-gha-infra  ← GitHub Actions deploy role for this repo
  └── SSM: /ctech/global/...     ← OIDC provider ARN, wildcard cert ARN

Ctech-{Env}-Network              (per environment: dev / stage / prod)
  └── VPC (dual-stack IPv4+IPv6, 0 NAT gateways)
  └── Security Group: ALB SG
  └── SSM: /ctech/{env}/network/...

Ctech-{Env}-ALB                  (per environment)
  └── Application Load Balancer (dual-stack, no public IPv4)
  └── HTTP → HTTPS redirect listener
  └── HTTPS listener (default: 503 - service rules added by each service CDK)
  └── SSM: /ctech/{env}/alb/...

Ctech-{Env}-S3                   (per environment)
  └── S3: {env}-ctech-deployments      ← release artifacts, 30-day expiry
  └── S3: {env}-ctech-application-logs ← rotated log archives, retained
  └── SSM: /ctech/{env}/s3/...

Ctech-{Env}-Valkey               (per environment)
  └── Valkey (AL2023 EC2 ASG, private, SG-only 6379) ← shared cache for ALL services
  └── SSM: /ctech/{env}/valkey/url   ← base URL; consumers append DB number (/0 cache, /1 ws, /2+)
  └── prod minCapacity=1; non-prod minCapacity=0 (scale-out on CacheUnavailable, scale-in idle)
```

> The Valkey stack is deployed by `bin/ctech-cdk.ts:72` and is **not** yet reflected in the
> architecture diagram that predates it — see `lib/valkey-stack.ts:23`.

### SSM Parameters written by this repo

| Path | Description |
|---|---|
| `/ctech/global/oidc/provider-arn` | GitHub OIDC provider ARN |
| `/ctech/global/acm/cert-arn` | Wildcard ACM certificate ARN (`*.arturocarvalho.com`) |
| `/ctech/{env}/network/vpc-id` | Shared VPC ID |
| `/ctech/{env}/network/alb-sg-id` | ALB security group ID |
| `/ctech/{env}/alb/arn` | ALB ARN |
| `/ctech/{env}/alb/dns-name` | ALB DNS name |
| `/ctech/{env}/alb/https-listener-arn` | HTTPS listener ARN - used by service CDKs to attach listener rules |
| `/ctech/{env}/s3/deployments-bucket` | Shared deployments bucket name (`{env}-ctech-deployments`) |
| `/ctech/{env}/s3/logs-bucket` | Shared logs bucket name (`{env}-ctech-application-logs`) |

`{env}` is `dev`, `stage`, or `prod`.

---

## How service CDKs consume shared infra

Service CDKs read from SSM at deploy time:

```typescript
// ALB SG and listener: CloudFormation tokens (resolved at deploy time)
const albSgId = ssm.StringParameter.valueForStringParameter(this, `/ctech/${env}/network/alb-sg-id`);
const listenerArn = ssm.StringParameter.valueForStringParameter(this, `/ctech/${env}/alb/https-listener-arn`);

// VPC ID: must be a concrete string at synth time - read via env var populated from SSM in CI
const vpc = ec2.Vpc.fromLookup(this, 'Vpc', { vpcId: process.env.CTECH_VPC_ID });

// Shared S3 buckets: read via env vars populated from SSM in CI
const deploymentsBucket = process.env.CTECH_DEPLOYMENTS_BUCKET ?? `${env}-ctech-deployments`;
const logsBucket        = process.env.CTECH_LOGS_BUCKET        ?? `${env}-ctech-application-logs`;

// IAM: always scope to the service's own prefix — never grant access to the whole bucket
new iam.PolicyStatement({
  actions: ['s3:GetObject'],
  resources: [`arn:aws:s3:::${deploymentsBucket}/my-service/*`],
});
```

Each service creates its own security group with ingress from the ALB SG, then attaches an `ApplicationListenerRule` to the shared listener.

### S3 path conventions

| Service         | Deployments prefix | Logs prefix        |
|-----------------|--------------------|--------------------|
| `ctech-account` | `ctech-account/`   | `ctech-account/`   |
| `py-dfe`        | `py-dfe/api/`      | `py-dfe/`          |
| New service     | `{service-name}/`  | `{service-name}/`  |

CI workflows read bucket names from SSM and export them before `cdk deploy`:

```yaml
- name: Read ctech shared infrastructure values
  run: |
    ENV="${{ steps.env.outputs.name }}"
    echo "CTECH_VPC_ID=$(aws ssm get-parameter --name /ctech/${ENV}/network/vpc-id --query Parameter.Value --output text)" >> "$GITHUB_ENV"
    echo "CTECH_DEPLOYMENTS_BUCKET=$(aws ssm get-parameter --name /ctech/${ENV}/s3/deployments-bucket --query Parameter.Value --output text)" >> "$GITHUB_ENV"
    echo "CTECH_LOGS_BUCKET=$(aws ssm get-parameter --name /ctech/${ENV}/s3/logs-bucket --query Parameter.Value --output text)" >> "$GITHUB_ENV"
```

---

## Environments

| Branch | Environment |
|---|---|
| `main` | `prod` |
| `staging` | `stage` |
| `dev` (or any other) | `dev` |

---

## Deploying

### Prerequisites

- Node.js 24
- AWS CLI configured with credentials that have `AdministratorAccess`
- CDK bootstrapped in the target account: `npx cdk bootstrap aws://868899309401/us-east-1`

### First-time bootstrap (manual - one time only)

The `ctech-gha-infra` GitHub Actions role does not exist yet on a fresh account, so the first deploy must be done locally with admin credentials:

```bash
npm ci

# 1. Deploy global stack (creates the ctech-gha-infra role)
ENVIRONMENT=dev npx cdk deploy Ctech-Global --require-approval never

# 2. Deploy per-environment stacks
ENVIRONMENT=dev npx cdk deploy "Ctech-Dev-*" --require-approval never
```

After this, all subsequent deploys run automatically via GitHub Actions.

### Local deploy (any environment)

```bash
npm ci
ENVIRONMENT=prod npx cdk deploy --all --require-approval never
```

### Diff before deploying

```bash
ENVIRONMENT=dev npx cdk diff --all
```

---

## GitHub Actions

The workflow (`.github/workflows/ctech-cdk.yml`) runs on every push and PR:

- **PR**: runs `cdk diff --all` and posts the result as a PR comment
- **Push**: deploys `Ctech-Global` (idempotent), then `Ctech-{Env}-*` for the target environment

The workflow uses the `ctech-gha-infra` IAM role (created by `GlobalStack`), assumed via GitHub OIDC - no long-lived AWS credentials are stored in GitHub.

---

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `ENVIRONMENT` | `dev` | Deployment environment (`dev` / `stage` / `prod`) |
| `AWS_ACCOUNT` | `868899309401` | AWS account ID |
| `AWS_REGION` | `us-east-1` | AWS region |
| `AWS_CERTIFICATE_ARN` | (see `lib/constants.ts`) | Wildcard ACM cert ARN |
| `GITHUB_REPO` | `artur-oliveira/ctech-cdk` | Repo allowed to assume `ctech-gha-infra` |

---

## Migrating resources from py-dfe-cdk

The VPC, ALB, and ALB SG currently owned by `py-dfe-cdk`'s `PyDfe-{Env}-Network` and `PyDfe-{Env}-ALB` stacks must be transferred to this repo before the old stacks are deleted.

**Zero-downtime path (recommended):**

```bash
# 1. Deploy ctech-cdk - creates new resources (or import existing ones)
ENVIRONMENT=prod npx cdk deploy "Ctech-Prod-*"

# 2. Import existing AWS resources into the new stacks to avoid recreation
ENVIRONMENT=prod npx cdk import "Ctech-Prod-Network"
ENVIRONMENT=prod npx cdk import "Ctech-Prod-ALB"

# 3. Once ctech-cdk owns the resources, destroy the old py-dfe-cdk stacks
cd ../py-dfe/py-dfe-cdk
ENVIRONMENT=prod npx cdk destroy "PyDfe-Prod-Network" "PyDfe-Prod-ALB"
```

### OIDC provider ownership

The GitHub OIDC provider is currently owned by `py-dfe-cdk`'s `PyDfe-Global-OIDC` stack. `ctech-cdk` imports it by ARN (read-only). To transfer ownership:

```bash
# In ctech-cdk
npx cdk import Ctech-Global   # imports the provider resource
# Then remove it from py-dfe-cdk's OidcStack and redeploy py-dfe-cdk
```

---

## Exported API — npm `@aoctech/cdk` (audited, file:line)

`lib/index.ts:1-9` is the **entire** public surface of the published package:

- `Environment` type — `lib/index.ts:1` (= `lib/types.ts:1`).
- `PrivateIpv4Ec2Service` construct + `PrivateIpv4Ec2ServiceProps` — `lib/index.ts:2`
  (`lib/private-ipv4-ec2-service.ts:73` / props `:21`). The shared no-NAT private-IPv4 EC2/ASG
  pattern: SG, app+nginx log groups, HTTP 2XX/3XX/4XX/5XX metric filters, target group, ASG with
  combined EC2+ELB health checks, and a listener rule on the shared HTTPS listener.
- UserData fragments — `lib/index.ts:3-8`: `addDualStackSsmAgentCommands` `ec2-userdata-fragments.ts:11`,
  `addCloudWatchAgentDualStackOverride` `:24`, `addSwapCommands` `:35`, `addRealipRefreshCommands` `:61`.

**Not exported from the package** (but present in `lib/` as in-repo stacks, deployed by
`bin/ctech-cdk.ts:32-77`): `GlobalStack` `lib/global-stack.ts:13`, `NetworkStack` `lib/network-stack.ts:13`,
`AlbStack` `lib/alb-stack.ts:18`, `S3Stack` `lib/s3-stack.ts:12`, `ValkeyStack` `lib/valkey-stack.ts:23`.

### SSM path constants (`lib/constants.ts:7-30`)

`SSM` is defined here but **is not re-exported from `lib/index.ts`** — see divergence B15 below.

| Path (canonical) | Defined at |
|---|---|
| `/ctech/global/oidc/provider-arn`, `/ctech/global/acm/cert-arn` | `constants.ts:9-10` |
| `/ctech/{env}/network/vpc-id`, `/ctech/{env}/network/alb-sg-id` | `constants.ts:13-14` |
| `/ctech/{env}/alb/arn`, `/ctech/{env}/alb/dns-name`, `/ctech/{env}/alb/https-listener-arn` | `constants.ts:17-19` |
| `/ctech/{env}/valkey/url` | `constants.ts:23-25` |
| `/ctech/{env}/s3/deployments-bucket`, `/ctech/{env}/s3/logs-bucket` | `constants.ts:27-29` |

---

## Known divergences / hypotheses (implementation is source of truth)

- **B15 — `SSM` constant is not exported.** `lib/index.ts` does not export `SSM` (or `DEFAULT_*`
  constants) from `lib/constants.ts`. All four consumer CDKs (`ctech-account/cdk`, `ctech-dfe/cdk`,
  `ctech-wallet/cdk`, `ctech-poker/cdk`, each pinning `@aoctech/cdk@^0.1.0`) import the construct
  helpers but **re-declare the SSM path strings locally** (e.g. `shared.albSgId`,
  `SSM_ACCOUNT(env).baseUrl` in `ctech-wallet/cdk/lib/reconcile-stack.ts:157`). Each consumer is the
  source of truth for its own SSM literals, so a rename in `lib/constants.ts` will *not* propagate —
  treat any SSM path change as a breaking change across all consumers, exactly as `CLAUDE.md` warns.
  *Fix candidate:* export `SSM` from `lib/index.ts` and migrate consumers onto it.
- **Stale stack list in `CLAUDE.md`.** `CLAUDE.md` names `IAMStack` and `OidcStack`, which do **not**
  exist in `lib/`. The real stacks are `GlobalStack`/`NetworkStack`/`AlbStack`/`S3Stack`/`ValkeyStack`.
  Also `CLAUDE.md` describes `GlobalStack` as owning an "OIDC provider reference" — it actually
  **creates** the provider (`lib/global-stack.ts:23`), not just references it. (The "owned by
  py-dfe-cdk" note under *Known Constraints* still holds for the transfer state.)
- **Valkey not in the architecture diagram** (now added above) — `ValkeyStack` existed in `lib/` but
  was missing from the rendered diagram and from `CLAUDE.md`'s stack list.
