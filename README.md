# ctech-cdk

AWS CDK (TypeScript) for account-level shared infrastructure. Owns the VPC, shared ALB, and GitHub Actions OIDC deploy role used by all CTech services. Service CDKs (py-dfe-cdk, etc.) consume these resources via SSM Parameter Store — they never depend on this repo's CloudFormation stacks directly.

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
  └── HTTPS listener (default: 503 — service rules added by each service CDK)
  └── SSM: /ctech/{env}/alb/...
```

### SSM Parameters written by this repo

| Path | Description |
|---|---|
| `/ctech/global/oidc/provider-arn` | GitHub OIDC provider ARN |
| `/ctech/global/acm/cert-arn` | Wildcard ACM certificate ARN (`*.arturocarvalho.com`) |
| `/ctech/{env}/network/vpc-id` | Shared VPC ID |
| `/ctech/{env}/network/alb-sg-id` | ALB security group ID |
| `/ctech/{env}/alb/arn` | ALB ARN |
| `/ctech/{env}/alb/dns-name` | ALB DNS name |
| `/ctech/{env}/alb/https-listener-arn` | HTTPS listener ARN — used by service CDKs to attach listener rules |

`{env}` is `dev`, `stage`, or `prod`.

---

## How service CDKs consume shared infra

Service CDKs read from SSM at deploy time:

```typescript
// ALB SG and listener: CloudFormation tokens (resolved at deploy time)
const albSgId = ssm.StringParameter.valueForStringParameter(this, `/ctech/${env}/network/alb-sg-id`);
const listenerArn = ssm.StringParameter.valueForStringParameter(this, `/ctech/${env}/alb/https-listener-arn`);

// VPC ID: must be a concrete string at synth time — read via env var populated from SSM in CI
const vpc = ec2.Vpc.fromLookup(this, 'Vpc', { vpcId: process.env.CTECH_VPC_ID });
```

Each service creates its own security group with ingress from the ALB SG, then attaches an `ApplicationListenerRule` to the shared listener.

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

### First-time bootstrap (manual — one time only)

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

The workflow uses the `ctech-gha-infra` IAM role (created by `GlobalStack`), assumed via GitHub OIDC — no long-lived AWS credentials are stored in GitHub.

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
# 1. Deploy ctech-cdk — creates new resources (or import existing ones)
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
