# CLAUDE.md - ctech-cdk

Account-level AWS CDK (TypeScript). Owns shared infrastructure consumed by all CTech services: VPC, ALB, OIDC deploy
role. Service CDKs are decoupled from this repo via SSM Parameter Store.

---

## Projects

| Repo                | Role                                                      |
|---------------------|-----------------------------------------------------------|
| `ctech-cdk/`        | This repo - account-level shared infra                    |
| `py-dfe-cdk/`       | py-dfe service infra (consumes SSM params from this repo) |
| Future service CDKs | Auth, Domino, Poker - same consumption pattern            |

---

## Architecture

**Stacks:**

- `GlobalStack` → **creates** the GitHub OIDC provider (`lib/global-stack.ts:23`), `ctech-gha-infra` IAM role, SSM pointers for OIDC + cert ARN
- `NetworkStack` → Dual-stack VPC (no NAT), ALB SG; writes VPC ID + ALB SG ID to SSM
- `AlbStack` → Shared ALB, HTTP→HTTPS redirect, HTTPS listener; writes ARN + DNS + listener ARN to SSM
- `S3Stack` → Shared deployments + logs buckets; writes bucket names to SSM (`/ctech/{env}/s3/...`)
- `ValkeyStack` → Shared Valkey cache (AL2023 EC2 ASG, private, SG-only 6379); writes `/ctech/{env}/valkey/url` (base URL, consumers append DB number). prod min=1, non-prod min=0 with scale-out on `CacheUnavailable` / scale-in when idle.

**S3 bucket naming:**
- `{env}-ctech-deployments` — all services upload release artifacts here under `{service-name}/`
- `{env}-ctech-application-logs` — all services upload rotated logs here under `{service-name}/`

Service CDKs read bucket names from `CTECH_DEPLOYMENTS_BUCKET` / `CTECH_LOGS_BUCKET` env vars (set from SSM in CI)
and scope their IAM permissions to `{bucket}/{service-name}/*` — never to the whole bucket.

**SSM parameter convention (canonical paths in `lib/constants.ts`):**

- `/ctech/global/{resource}` - account-scoped, environment-independent
- `/ctech/{env}/{service}/{resource}` - per-environment (`dev` / `stage` / `prod`)

**Stack naming convention:** `Ctech-Global` (once), `Ctech-{Env}-{Name}` (per environment).

---

## Mandatory Workflow

For every change:

1. Check `lib/constants.ts` for SSM path and default constant definitions before adding new ones
2. Search for similar patterns in existing stacks - reuse before creating
3. Plan → Implement → `npx tsc --noEmit` (must be clean)
4. Consider cross-service impact: any SSM path rename or removal breaks all service CDKs that consume it - treat these
   as breaking changes
5. Suggest Conventional Commit (`feat:` / `fix:` / `refactor:` / `chore:`)

---

## Scope Control

This repo owns **only** account-level shared infrastructure. Do not add service-specific resources (DynamoDB tables,
Lambda functions, S3 buckets for a specific service). Those belong in the service's own CDK repo.

Service security groups (e.g., `py-dfe-api-sg`) are **not** managed here - each service CDK creates its own SG with
ingress from the shared ALB SG.

---

## Never Assume

- Never hardcode VPC IDs, SG IDs, or ARNs in service CDKs - they must read from SSM
- Never assume SSM parameter paths exist without checking `lib/constants.ts`
- Never assume the ALB listener priority - service CDKs own their priorities; conflicts fail at deploy time
- Never grant a service IAM permissions to `{shared-bucket}/*` — always scope to `{bucket}/{service-name}/*`

---

## Engineering Rules

**SSM parameters:**

- All paths MUST be defined in `lib/constants.ts` via the `SSM` object - never declared as string literals in stack
  files
- Before adding a new parameter, check if it already exists in `lib/constants.ts`
- Renaming a parameter path is a breaking change for all consuming service CDKs
- **B15 (divergence):** `SSM` (and `DEFAULT_*` constants) are NOT re-exported from `lib/index.ts`, so the
  published `@aoctech/cdk` package does not expose them. Consumers (`ctech-account/cdk`, `ctech-dfe/cdk`,
  `ctech-wallet/cdk`, `ctech-poker/cdk`) re-declare SSM path strings locally. A `lib/constants.ts` rename
  will NOT propagate — update each consumer by hand. Fix candidate: export `SSM` from `lib/index.ts`.

**Constants:**

- Default values (`DEFAULT_AWS_ACCOUNT`, `DEFAULT_CERTIFICATE_ARN`, etc.) live in `lib/constants.ts`
- Env vars override defaults in `bin/ctech-cdk.ts`

**Types:**

- `SSMParams` interface in `lib/types.ts` enforces the shape of the `SSM` constant - keep them in sync

**Security:**

- `ctech-gha-infra` uses `AdministratorAccess` - this is intentional for CDK infra management
- Never add service-specific permissions to `ctech-gha-infra`; each service manages its own deploy roles
- The GitHub OIDC provider is created by `GlobalStack` (`lib/global-stack.ts:23`) in this repo. The
  `py-dfe-cdk` `PyDfe-Global-OIDC` stack historically owned it; transfer is tracked in the README's
  "OIDC provider ownership" section. `GlobalStack` does NOT merely import it by ARN.

**S3 buckets:**

- `{env}-ctech-deployments`: lifecycle rule deletes all objects after 30 days (artifacts are transient)
- `{env}-ctech-application-logs`: no expiry — logs are retained indefinitely; both buckets use `RETAIN` removal policy
- Adding a new service: upload artifacts to `{bucket}/my-service/`, grant IAM on `{bucket}/my-service/*` only

**RemovalPolicy:**

- VPC, ALB, and shared S3 buckets: always `RETAIN` — destroying them would break running services
- When adding new shared resources, always consider whether destroying them would break running services

**AWS costs:**

- Zero NAT gateways - all instances must use IPv6 or VPC endpoints for AWS service access
- One ALB per environment (shared across all services) - new services add listener rules, not new ALBs

---

## Adding a New Service

When a new service CDK (e.g., `auth-cdk`) needs shared infra:

1. It reads VPC ID via `CTECH_VPC_ID` env var (populated from SSM in CI before `cdk deploy`)
2. It reads ALB SG ID via `ssm.StringParameter.valueForStringParameter(this, SSM.network(env).albSgId)`
3. It reads HTTPS listener ARN via `ssm.StringParameter.valueForStringParameter(this, SSM.alb(env).httpsListenerArn)`
4. It reads shared bucket names via `CTECH_DEPLOYMENTS_BUCKET` / `CTECH_LOGS_BUCKET` env vars (set from `/ctech/{env}/s3/*` SSM in CI)
5. It creates its own service SG with `addIngressRule(albSg, ec2.Port.tcp(<port>), ...)`
6. It adds an `ApplicationListenerRule` with a unique priority
7. It grants IAM permissions scoped to `{bucket}/my-service/*` — never the whole bucket

No changes to `ctech-cdk` are required for a new service to attach to the shared ALB or use the shared S3 buckets.

---

## Known Constraints

- `Vpc.fromLookup` requires a concrete VPC ID at synthesis time (not a CloudFormation token). Service CDKs must receive
  `CTECH_VPC_ID` as an env var from CI, not via `valueForStringParameter`.
- The ALB uses `DUAL_STACK_WITHOUT_PUBLIC_IPV4` - instances behind it must be reachable over IPv6.
- `GlobalStack` is deployed on every push (it is idempotent - CloudFormation only updates changed resources).
