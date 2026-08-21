# Frontend Cloudflare Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:
> executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve the five CTech front ends (`ctech-account`, `ctech-billing`, `ctech-dfe`, `ctech-poker`, `ctech-wallet`)
from Cloudflare instead of CloudFront, on the same hostnames, and delete the S3 + CloudFront + KeyValueStore delivery
path along with the CI/CD steps that maintain it.

**Architecture:** Each `ui/` stays a Next.js static export. `wrangler` uploads `out/` straight to a Cloudflare project —
one project per service per environment, 15 total — from a single reusable GitHub workflow hosted in `ctech-cdk`. Pretty
URLs and the 404 page become the platform's own asset routing (`assets.html_handling` and
`assets.not_found_handling` in a committed `wrangler.jsonc`), so the CloudFront Function and its KeyValueStore route
manifest are deleted rather than reimplemented. Security headers move from `ResponseHeadersPolicy` into a generated
`_headers` file. Nothing is proxied at the edge: every browser call goes directly to `<service>-api[-env].aoctech.app`,
which is already the case for four of the five apps.

**Tech Stack:** Cloudflare Workers Static Assets via `wrangler deploy` (decided in Phase 0, see D6), GitHub Actions
reusable workflows, AWS CDK v2 (TypeScript) for teardown, Terraform for `ctech-billing` teardown, Go 1.2x + Fiber v3 for
the poker avatar handler, Next.js 16 static export.

**Spec:** none — decisions are recorded inline below.

---

## Decisions (2026-08-20)

**D1 — No edge proxying.** `/v1.0/*`, `/.well-known/*`, `/docs`, `/openapi.*` are not forwarded from the app hostname.
Every browser call targets the API hostname.

Verified safe because:

- No backend fetches JWKS from the public app host. `CTECH_JWKS_URL` is `/ctech-account/{env}/internal-jwks-url` —
  internal DNS through HAProxy's private frontend (`ctech-poker/cdk/lib/api-stack.ts:269`,
  `ctech-wallet/cdk/lib/api-stack.ts:120`, `ctech-dfe/cdk/lib/api-stack.ts:151`).
- `CTECH_ISSUER_URL` is `/ctech-account/{env}/app-url` and is compared as a string, never dereferenced. The app keeps
  that hostname, so the `iss` claim of every issued token is unchanged and no token is invalidated by the migration.
- Only `ctech-dfe` still calls its API same-origin. Its API already ships `AllowCredentials: true` with
  `CORS_ALLOWED_ORIGINS="$SERVICE_AUDIENCE"` (the dfe app URL) — `ctech-dfe/api/internal/app/app.go:203-209`,
  `ctech-dfe/cdk/lib/api-stack.ts:165`. The flip is one environment variable in CI, with no infrastructure change.

**Accepted limit:** `accounts.aoctech.app` remains the `iss` while no longer serving
`/.well-known/openid-configuration`. Non-conformant for a third-party OIDC client that discovers by issuer. Internal
clients are unaffected. If a third-party integration ever lands, the fix is to move `app-url` to the API hostname behind
a dual-accept window — not to reintroduce a proxy.

**D2 — Poker avatars are served by the poker API from the existing private bucket.** `avatar.Service` already holds an
S3 client with `GetObject` and the instance role already grants it. A new public read handler streams `av/<key>` with
immutable cache headers; `AVATAR_BASE_URL` (SSM `/ctech/{env}/poker/avatar-base-url`) is repointed at it. The bucket
keeps `BlockPublicAccess.BLOCK_ALL`, no credential lands in an edge script, and no distribution or hostname is created.
Fallback, if instance egress or CPU ever shows up in metrics: one CloudFront distribution for avatars alone on its own
hostname, which is a single SSM value away.

**D3 — Wallet drops the locale redirect.** `LOCALIZED_PUBLIC_ROUTES` is `['/']` and `ui/src/app/page.tsx` is already a
client component using `react-i18next`, so the language is chosen in the browser regardless. `/en` and `/pt-BR` stay as
canonical URLs (`export {default} from '@/app/page'` plus localized metadata) and gain `hreflang` links. The CloudFront
Function's 307 machinery, `LOCALE_COOKIE_NAME` and `LOCALIZED_PUBLIC_ROUTES` leave the CDK. The `LanguageSwitcher`
cookie keeps working as a client-side preference.

**D4 — Deploy credential is a long-lived Cloudflare API token.** Cloudflare has no GitHub OIDC trust. This is a
deliberate regression from assumed roles: one token per repository, scoped to a single account and to edit rights on
that repository's projects only, stored as `CLOUDFLARE_API_TOKEN`, rotated on a schedule recorded in each repo's
`DEPLOYMENT.md`.

**D5 — DFE `/docs` moves to the API hostname.** `dfe-api[-env].aoctech.app/docs` and `/openapi.{json,yaml}`. No UI code
links to them (only a comment in `ui/src/lib/types/billing.ts`), so this is a documentation change.

**D6 — Target is an assets-only Worker, not Pages (decided in Phase 0).** Both products serve static assets for free,
share the same `_headers`/`_redirects` parser and the same 20,000-file / 25 MiB free-plan limits, so the choice comes
down to operability:

- Workers puts the two correctness gates of this migration into a reviewed, committed file. `assets.html_handling` and
  `assets.not_found_handling: "404-page"` are declared in `ui/wrangler.jsonc`
  (<https://developers.cloudflare.com/workers/static-assets/routing/static-site-generation/>). On Pages Direct Upload
  the same behaviour is an implicit platform default with no config surface, which is a poor fit for a repo where the
  route manifest used to be explicit.
- Pages Direct Upload is a one-way door: a Direct Upload project can never be switched to Git integration, and its
  production branch is only editable through a raw `PATCH` to the REST API
  (<https://developers.cloudflare.com/pages/get-started/direct-upload/>).
- The paid file ceiling is 100,000 on Workers directly, versus Pages needing the `PAGES_WRANGLER_MAJOR_VERSION=4`
  environment variable to unlock the same number.
- Cloudflare ships a *Migrate from Pages to Workers* guide and links it from the Pages navigation. There is no guide in
  the other direction. Starting 15 new projects on the side being migrated away from is avoidable.
- If the edge-proxy question of D1 ever comes back, `assets.run_worker_first` adds it to the same project with no
  migration. On Pages the equivalent is `_worker.js`, which bills every asset request as an invocation.

Cost of the choice: 15 of the free plan's 100 Workers per account. Asset requests do not consume the 100,000/day
request quota, because an assets-only Worker has no `main` script to invoke.

`wrangler.jsonc` is **generated by the reusable workflow**, not committed per repo. D6's argument is against an implicit
platform default, not against central configuration: one generated file for all 15 deployments cannot drift, whereas
five committed copies can. The generator lives in one reviewed place, which is the same reason the CDK construct existed.

**D7 — `connect-src` is derived from the build environment, never passed in.** The reusable workflow scans the selected
`build-env` block for `https://` and `wss://` origins and builds `connect-src` from them, plus an `extra-connect-src`
input for the few origins that are not a `NEXT_PUBLIC_*` value (`viacep.com.br`, the KYC buckets). Overriding
`connect-src` through `csp-overrides` is a hard error.

This exists because the two sources disagree today. `ctech-dfe/cdk/bin/ctech-dfe-cdk.ts:189` feeds the CSP from
`domainForEnv(ENVIRONMENT, 'accounts-api')`, which yields **`accounts-api-dev.aoctech.app`**, while all four frontend
workflows build the app against **`accounts-dev-api.aoctech.app`**
(`ctech-dfe/.github/workflows/frontend.yml:64`, `ctech-account/.github/workflows/frontend.yml:55`,
`ctech-wallet/.github/workflows/frontend.yml:65`, `ctech-poker/.github/workflows/frontend.yml:114`). The two spellings
collapse to the same name only in prod, which is why nothing surfaced. Deriving the CSP from the values the app was
built with makes this class of mismatch unrepresentable. See the open question below.

---

## Open question — the `accounts-api` hostname

Which spelling actually has a DNS record in Cloudflare for dev and stage?

- `accounts-api-dev` / `accounts-api-stage` — what `domainForEnv(env, 'accounts-api')` produces, and therefore what the
  current CloudFront CSP allows.
- `accounts-dev-api` / `accounts-stage-api` — what all four frontends are built against.

If the second is the live record, then `connect-src` on dev and stage has been blocking the OAuth token exchange
(`ui/src/lib/auth/oauth.ts:41` builds `OAuthClient` with `baseUrl: NEXT_PUBLIC_CTECH_URL`, and the exchange is a
`fetch`, so `connect-src` applies) — a pre-existing bug that only non-prod sees. If the first is live, the four
workflows have been building against a name that does not resolve. Either way something is broken in dev and stage
today and the migration did not cause it.

D7 makes the generated CSP follow the build, so the app and its policy will agree after Phase 2 regardless of the
answer. What still needs deciding is which spelling becomes canonical, so that `ctech-account`'s CDK and the four
callers say the same thing. Not a blocker for Phase 1.

Unverifiable from this machine: the public API path is IPv6-only through HAProxy
(`ctech-lbalancer/README.md`), and every probe returned `000`, including prod.

---

## Global Constraints

- Every `ui/` is and stays `output: 'export'`. No SSR, no route handlers, no image optimizer is introduced by this plan.
- Public hostnames do not change: `accounts`, `billing`, `dfe`, `poker`, `wallet` (+ `-stage`, `-dev`) under
  `aoctech.app`.
- CloudFront distributions and their buckets stay deployed until the environment's soak window passes. Rollback in every
  phase is a DNS record in Cloudflare, not a redeploy.
- DNS lives in Cloudflare and is edited there. Route53 is not involved in the app hostnames.
- One deploy at a time per branch stays true: the frontend job keeps running inside each repo's existing `deploy.yml`
  ordering and `concurrency` group.
- The reusable workflow lives in `ctech-cdk`. Because these repositories are user-owned rather than org-owned,
  `ctech-cdk` → Settings → Actions → Access must allow use from other repositories owned by the same user, or the
  callers cannot resolve it.
- Conventional Commits. Never add a `Co-Authored-By` trailer.
- Cloudflare account already exists — Turnstile is in production use by `ctech-poker`.

---

## Platform limits — answered 2026-08-20

Sources: `developers.cloudflare.com/pages/platform/limits/` (updated 2026-07-16),
`developers.cloudflare.com/workers/platform/limits/`, `developers.cloudflare.com/workers/static-assets/headers/`,
`developers.cloudflare.com/pages/get-started/direct-upload/`. Measurements are from the local `ui/out` of each repo
(`ctech-dfe` rebuilt with `NODE_ENV=production next build`, the other four from their existing exports).

- [x] **File count per deployment — 20,000 free / 100,000 paid.** Largest export is `ctech-poker` at 660 files, 3.0% of
  the free limit. `ctech-account` 601, `ctech-dfe` 550, `ctech-wallet` 101, `ctech-billing` 95. Not a constraint, and
  not one that growth reaches.
- [x] **Maximum single file size — 25 MiB.** Largest asset anywhere is `ctech-dfe`'s
  `out/_next/static/chunks/1o_2ai79a_d-v.js` at 7.86 MB (30% of the limit). Next largest across the other four is
  `ctech-poker/out/og-image.webp` at 393 KB. Not a constraint, but the dfe chunk is worth a look on its own merits — it
  is 45% of that app's 17.6 MB export.
- [x] **Build quota does not apply.** The 500-builds-per-month free limit is documented under *Builds* as "each time you
  push new code to your Git repository, Pages will build and deploy your site" — it meters Cloudflare-run builds. D6
  moves off Pages anyway: `wrangler deploy` of a prebuilt `out/` is a deployment, not a build, and Workers has no
  monthly deployment quota. GitHub Actions keeps doing the building.
- [x] **`_headers` — 100 rules, 2,000 characters per line.** The generated file needs 2 rules (one `/*` block, one
  `/_next/static/*` block). The longest line is the CSP: 340 characters for dfe dev, the widest `connect-src` of the
  five. Both limits have two orders of magnitude of headroom.
- [x] **Project and domain counts.** Workers allows 100 Workers per account on the free plan (500 paid); this plan uses
  15. Custom domains are per-Worker routes on an existing zone, one each. Neither is close. (For the record, had Pages
  been chosen: 100 projects per account, 100 custom domains per project.)
- [x] **Pages Direct Upload vs assets-only Worker — assets-only Worker.** Recorded as D6 above with reasoning.

Two findings that change how the rest of the plan is written:

- **`CF-Cache-Status` on static assets is explicitly documented as probabilistic** — "It is possible for false-positives
  and false-negatives to occur … this header should be considered as returning a 'probabilistic' result." The Phase 0
  gate about seeing a cache `HIT` is therefore informational, not pass/fail. Measure the migration's latency win with
  timings against the current chain, not with this header.
- **The default asset response is `Cache-Control: public, max-age=0, must-revalidate` plus an `ETag`.** CloudFront's
  `CACHING_OPTIMIZED` cached at the edge but S3 sent no `Cache-Control`, so browsers never cached the hashed
  `_next/static` chunks either. The generated `_headers` adds
  `Cache-Control: public, max-age=31536000, immutable` for `/_next/static/*`, which content-hashed filenames make safe.
  This is a genuine improvement, not a port.

---

## Project and domain map

Worker naming: `ctech-<service>-<env>`. Fifteen Workers, fifteen custom domains, one zone.

| Service | dev                        | stage                        | prod                   |
|---------|----------------------------|------------------------------|------------------------|
| account | `accounts-dev.aoctech.app` | `accounts-stage.aoctech.app` | `accounts.aoctech.app` |
| billing | `billing-dev.aoctech.app`  | `billing-stage.aoctech.app`  | `billing.aoctech.app`  |
| dfe     | `dfe-dev.aoctech.app`      | `dfe-stage.aoctech.app`      | `dfe.aoctech.app`      |
| poker   | `poker-dev.aoctech.app`    | `poker-stage.aoctech.app`    | `poker.aoctech.app`    |
| wallet  | `wallet-dev.aoctech.app`   | `wallet-stage.aoctech.app`   | `wallet.aoctech.app`   |

---

## File Structure

**Created in `ctech-cdk`:**

| Path                                                     | Responsibility                                                                                                                           |
|----------------------------------------------------------|------------------------------------------------------------------------------------------------------------------------------------------|
| `.github/workflows/frontend-cloudflare.yml`              | Reusable workflow: build, generate `out/_headers`, `wrangler deploy --name ctech-<service>-<env>`. Owns everything the five copies of `frontend.yml` duplicate today. |
| `docs/plans/2026-08-20-frontend-cloudflare-migration.md` | This plan.                                                                                                                               |

**Deleted in `ctech-cdk`:** `lib/nextjs-static-frontend.ts` (217 lines) and its export from `lib/index.ts`, plus any
test covering it.

**Per service repository:**

| Path                                                                                                                | Change                                                                                                        |
|---------------------------------------------------------------------------------------------------------------------|---------------------------------------------------------------------------------------------------------------|
| `.github/workflows/frontend.yml`                                                                                    | Replaced by a thin caller of the reusable workflow.                                                           |
| `ui/scripts/publish-routes.sh`                                                                                      | Deleted (362 lines across the five repos).                                                                    |
| `cdk/lib/frontend-stack.ts`                                                                                         | Deleted (`account` 59, `dfe` 95, `poker` 116, `wallet` 101).                                                  |
| `cdk/bin/*.ts`                                                                                                      | `FrontendStack` instantiation and its wiring removed.                                                         |
| `cdk/test/frontend-stack.test.ts`                                                                                   | Deleted (`dfe`, `poker`).                                                                                     |
| `cdk/lib/iam-stack.ts`, `cdk/lib/oidc-stack.ts`                                                                     | Frontend deploy role and its S3/CloudFront/KVS statements removed.                                            |
| `ui/CLAUDE.md`, `ui/AGENTS.md`, `ui/FRONTEND.md`, `ui/GUIDELINES.md`, `README.md`, `DEPLOYMENT.md`, `cdk/README.md` | Every statement that "CloudFront forwards `/v1.0/*` and `/.well-known/*`" is now false and must be rewritten. |
| `docs/adr/`                                                                                                         | New ADR per repo; `ctech-billing/docs/adr/0013-*` gets a second amendment.                                    |

**`ctech-billing` extra:** `terraform/billing/frontend.tf` deleted, `ssm.tf` frontend parameters removed, `iam.tf`
frontend role removed, `outputs.tf` trimmed.

**`ctech-poker` extra:** new avatar read handler + tests; `AvatarsBucket` moves out of the deleted `FrontendStack` into
a stack that survives.

**`ctech-wallet` extra:** `hreflang` links in `ui/src/app/layout.tsx`; locale constants removed from
`cdk/lib/constants.ts`.

---

## Phase 0 — Spike

Complete, 2026-08-20. Every gate passed on a live scratch Worker. Phase 1 is unblocked.

**Done:**

- [x] Answer the platform-limits checklist against current documentation and the actual exports — see *Platform limits*
  above.
- [x] Decide Pages Direct Upload vs assets-only Worker — assets-only Worker, recorded as D6.
- [x] Rebuild `ctech-dfe/ui` with `NODE_ENV=production next build` and confirm the export is a plain static tree: 550
  files, 75 HTML pages, no dynamic segments, routes exported as `dashboard.html` rather than `dashboard/index.html`
  (which is what makes `html_handling: "auto-trailing-slash"` the right value).
- [x] Write the spike kit: a `wrangler.jsonc`, a hand-written `_headers` that ports the `ResponseHeadersPolicy` built at
  `ctech-cdk/lib/nextjs-static-frontend.ts:120` with dfe's dev `connect-src`, and `verify.sh` asserting every gate
  below. Kit is committed at `docs/plans/2026-08-20-frontend-cloudflare-migration/`
  (`_headers`, `wrangler.jsonc`, `verify.sh`).

**Spike executed 2026-08-20 against `ctech-dfe-spike.aoctech.workers.dev`. All gates pass.**

- [x] Deploy the dfe export to a scratch Worker with the kit's `wrangler.jsonc` and `_headers`.
- [x] Pretty URLs resolve with no route manifest: `/`, `/dashboard`, `/guide/nfe`, `/nfe/emit` all `200`. The
  KeyValueStore was never doing anything the platform cannot do by itself.
- [x] `/dashboard/` returns **307** to `/dashboard`, which then returns `200`. Cloudflare normalises the trailing slash
  with a temporary redirect, not the 301/308 first assumed — `verify.sh` was corrected to accept any 3xx. See the note
  below.
- [x] An unknown path returns `404` **and** the export's own `404.html` body (13,048 bytes), so
  `not_found_handling: "404-page"` behaves as documented. This was the hard gate.
- [x] All five security headers and every asserted CSP directive match what `ResponseHeadersPolicy` produces today,
  including `connect-src` for `dfe-api-dev` and `accounts-api-dev`.
- [x] `/_next/static/*` serves `public, max-age=31536000, immutable`.
- [x] `cf-cache-status: HIT` on the second HTML request. Informational only per the caveat above, but it is the
  behaviour the current `viewer → Cloudflare → CloudFront` chain does not have: that one reports `DYNAMIC`.

**Still open — do during Phase 3 for `dfe-dev`, not now:**

- [ ] Attach `dfe-dev.aoctech.app`, confirm certificate issuance, and compare `curl -w '%{time_total}'` against the
  current CloudFront chain.
- [ ] Delete the `ctech-dfe-spike` Worker.

**Note on the 307.** A temporary redirect means crawlers and browsers will not treat the bare path as canonical, so a
trailing-slash link keeps costing a round trip forever. Not a correctness problem and not worth a Worker script to fix.
If it ever matters for SEO, the lever is `_redirects` with an explicit 301, or `html_handling: "drop-trailing-slash"`
— evaluate then, not now. No app in this set links with trailing slashes today.

**Gate cleared.** The 404 status and body are correct and `_headers` reproduces the CSP, so Phase 1 is unblocked.

---

## Phase 1 — Shared plumbing in `ctech-cdk`

Written 2026-08-20: `.github/workflows/frontend-cloudflare.yml`, 276 lines, one job.

- [x] `on: workflow_call` with inputs `service`, `working-directory` (default `ui`), `node-version` (default `24`),
  `build-command`, `test-command`, `build-env-dev`, `build-env-stage`, `build-env-prod`, `extra-connect-src`,
  `csp-overrides`, `permissions-policy`, `wrangler-version` (default `4.125.0`). Secrets `CLOUDFLARE_API_TOKEN` and
  `CLOUDFLARE_ACCOUNT_ID`.
- [x] Resolve the environment from `github.ref_name` (`main`→`prod`, `staging`→`stage`, else `dev`) and the Worker name
  `${service}-${env}`.
- [x] Select the environment's `build-env` block, write it to `build.env`, and append it to `$GITHUB_ENV`. A line that
  is not `KEY=value` fails the job rather than silently producing an undefined `NEXT_PUBLIC_*` at build time — which in
  a static export bakes `undefined` into the bundle.
- [x] Guard the export: `out/` must exist, must contain at least one HTML file, must be at or under 20,000 files, and
  must have no file over 25 MiB. This is the equivalent of `publish-routes.sh` refusing to run on an empty export.
- [x] Generate `out/_headers`: one `/*` block with the five security headers from `createNextjsStaticFrontend`, the
  derived `connect-src` (D7), and an optional `Permissions-Policy`; one `/_next/static/*` block with
  `Cache-Control: public, max-age=31536000, immutable`. Refuses any line over the 2,000-character `_headers` limit.
- [x] Verify the generated CSP as a separate step: the three structural directives must be present, and **every**
  `https://`/`wss://` origin found in `build.env` must appear in `connect-src`. An app built against an API its own
  policy forbids is the failure mode this migration would otherwise inherit.
- [x] Generate `wrangler.jsonc` with `html_handling: "auto-trailing-slash"` and `not_found_handling: "404-page"`, the
  two values Phase 0 proved on a live Worker.
- [x] Deploy with `wrangler` pinned exactly, then print the environment, the Worker name, the file count and the
  `workers.dev` URL to the job summary.

**Generator checked locally** against dfe's real dev `build-env`: derives
`connect-src 'self' https://dfe-api-dev.aoctech.app https://accounts-dev-api.aoctech.app https://accounts-dev.aoctech.app https://viacep.com.br`
at 340 characters; applies `csp-overrides` in place for a known directive (`img-src`) and appends an unknown one
(`media-src`); refuses a `connect-src` override; refuses an over-long header line.

**First live run, 2026-08-20 — `ctech-dfe-prod`.** The push landed on `main`, so the first deployment was the prod
build, at `ctech-dfe-prod.aoctech.workers.dev`. No DNS moved, so nothing in production changed. 475 files uploaded, 75
already present, 4.1 s. `verify.sh` passes every gate against it, and the generated policy is exactly what D7 promises:

```
connect-src 'self' https://dfe-api.aoctech.app wss://dfe-api.aoctech.app
            https://accounts-api.aoctech.app https://accounts.aoctech.app https://viacep.com.br
```

including the `wss://` origin the hook derives at runtime. `cf-cache-status: HIT` on the second HTML request.

`verify.sh` was parameterised as a result: expected `connect-src` origins are now positional arguments rather than the
dev hosts hardcoded, so the same script serves every service and environment.

**Added as a result: the `prod-workers-dev` input.** A Worker's `<name>.workers.dev` URL is a second public origin for
the same app, and it is *outside the zone* — no zone WAF rule, rate limit, bot rule or Access policy applies to it. That
is acceptable while it is the only way to reach a deployment, and not acceptable once `dfe.aoctech.app` points at the
Worker. Phase 3 flips this input to `false` per service after the prod custom domain is live; dev and stage keep
`workers.dev` unconditionally.

**Still to verify, and it cannot be done on `workers.dev`:** login, an authenticated request with its preflight, and the
WebSocket. From `ctech-dfe-prod.aoctech.workers.dev` the page origin is that hostname, which is not in
`CORS_ALLOWED_ORIGINS` (`https://dfe.aoctech.app`), so the API refuses the request and `wsAllowedOrigin` refuses the
upgrade. This is correct behaviour, not a bug — and it means the functional gates only pass once the custom domain is
attached. Do them on `dfe-dev.aoctech.app` in Phase 3, not here. Do **not** add a `workers.dev` origin to
`CORS_ALLOWED_ORIGINS` to work around it: that would leave a permanent allow-list entry for an origin nothing should
use.

---

## Phase 2 — Per repository

Each repository: replace `frontend.yml` with a caller, keep the `deploy.yml` ordering and path filters untouched.

**Amended while doing 2c:** the old workflow is *renamed* to `frontend-cloudfront.yml` rather than deleted, and
`publish-routes.sh` stays. Both are `workflow_call`-only and now unreferenced, so neither can ever run — but keeping
them means a rollback during the soak window can also ship a code change, not just flip DNS back to a frozen bucket.
They go in Phase 4 with the distribution. `deploy.yml`'s frontend job loses `id-token: write` (no AWS role any more) and
gains `secrets: inherit` so `CLOUDFLARE_*` reaches the reusable workflow two hops down.

### 2a — `ctech-account` (0.5 day)

- [ ] Replace `.github/workflows/frontend.yml` with a caller passing `connect-src` for `accounts-api[-env]`,
  `viacep.com.br` and the KYC document bucket hostnames — the exact list currently produced by
  `contentSecurityPolicyDirectives` in `cdk/lib/frontend-stack.ts`.
- [ ] Confirm `NEXT_PUBLIC_API_URL` already points at `accounts-api[-env]` (it does) and that nothing in `ui/src`
  fetches a relative `/.well-known/*`.
- [ ] Confirm auth cookies still land: `Domain` comes from SSM `/ctech-account/{env}/cookie-domain` with `SameSite=Lax`,
  so a Cloudflare-served app on the same registrable domain is unaffected. Test the full login round trip on `dev`
  before touching stage.

### 2b — `ctech-billing` (0.5 day)

- [ ] Replace `frontend.yml` with a caller. `NEXT_PUBLIC_API_URL` is already the API hostname and the CORS posture is
  already in `terraform/billing/locals.tf`.
- [ ] Drop the SSM reads (`frontend-bucket`, `frontend-distribution-id`, `frontend-route-store-arn`) and the
  invalidation wait.

### 2c — `ctech-dfe` — done 2026-08-20

- [x] `.github/workflows/frontend.yml` is now a 55-line caller of
  `artur-oliveira/ctech-cdk/.github/workflows/frontend-cloudflare.yml@main`, carrying only the three `build-env` blocks
  and `extra-connect-src: https://viacep.com.br`.
- [x] `NEXT_PUBLIC_API_URL` moved from `dfe[-env].aoctech.app` to `dfe-api[-env].aoctech.app` in all three
  environments.
- [x] `NEXT_PUBLIC_WS_URL` is now **set explicitly** per environment. It used to be left unset so
  `useRealtimeUpdates.ts:15` would fall back to `NEXT_PUBLIC_API_URL` and ride the CloudFront forward. The fallback
  would still resolve to the right host, but D7 builds `connect-src` from the literals in `build-env`, and the hook
  rewrites `https` to `wss` at runtime — so the derived policy would allow `https://dfe-api…` and block
  `wss://dfe-api…`. Setting it makes the origin visible to the generator.
- [x] **WebSocket origin check needs no change.** `wsAllowedOrigin` (`api/internal/api/v1/ws.go:62`) compares the
  upgrade's `Origin` header against `cfg.CorsAllowedOrigins`. That header is the *page's* origin, still
  `https://dfe[-env].aoctech.app`, which is exactly what `CORS_ALLOWED_ORIGINS="$SERVICE_AUDIENCE"` contains. Moving the
  socket to the API host changes the target, not the origin.
- [x] CORS needs no infrastructure change, for the same reason (`api/internal/app/app.go:203-209`,
  `cdk/lib/api-stack.ts:165`). Still to be exercised from a browser on `dev`.
- [x] `/docs` and `/openapi.*` documented as API-host-only in `DOCS.md` and `INTEGRATION.md`; the `next dev` rewrite
  stays as a local convenience and its comment in `ui/next.config.ts` says so.
- [x] `INTEGRATION.md`'s ui environment table was wrong independently of this work: it listed
  `NEXT_PUBLIC_CTECH_URL` as `accounts.aoctech.app` (the app) when the workflows have always set the API host, and it
  omitted `NEXT_PUBLIC_CTECH_CLIENT_URL` entirely. Both fixed.
- [x] `ui/wrangler.jsonc` deleted (it was the Phase 0 spike copy) and added to `.gitignore`, since D6 generates it.

**Not done, needs a browser on `dev`:** exercise login, one mutating request with its preflight, and the WebSocket
after the first deploy. That is the Phase 1 verification too — this repo is where the reusable workflow gets its first
real run.

### 2d — `ctech-wallet` (0.5 day)

- [ ] Replace `frontend.yml` with a caller.
- [ ] Add `hreflang` alternates for `/en` and `/pt-BR` in `ui/src/app/layout.tsx`.
- [ ] Confirm `/`, `/en` and `/pt-BR` all render the correct language with the edge redirect gone; keep
  `ui/src/app/localized-routes.test.mjs` and `homepage.test.mjs` green or rewrite them to assert the new contract.

### 2e — `ctech-poker` avatars (0.5–1 day)

- [ ] Add a public `GET /v1.0/avatars/*` handler backed by `avatar.Service`, streaming from the existing bucket.
- [ ] **Security:** validate the key against a strict pattern and force the `av/` prefix server-side. `up/` is the
  upload quarantine (unverified content, 1-day lifecycle) and must be unreachable through this handler. Add a test that
  a key attempting to reach `up/` or to traverse out of `av/` is rejected.
- [ ] Set `Cache-Control: public, max-age=31536000, immutable` and a strong `ETag`; the key changes on every new upload,
  so this is safe.
- [ ] Rate-limit the read path independently of `avatarLimiter` (which guards uploads), so a cold cache cannot be used
  to pull bytes through the `t4g.nano` in a loop.
- [ ] Serve `404` — never a redirect to a presigned URL, which would defeat Cloudflare's cache and leak an expiry.
- [ ] Repoint SSM `/ctech/{env}/poker/avatar-base-url` to `https://poker-api[-env].aoctech.app/v1.0/avatars`.
- [ ] Move `AvatarsBucket` out of `FrontendStack` into a surviving stack **before** deleting that stack, and keep its
  logical name so CloudFormation does not replace it. Its CORS rule (POST from the app domain) stays as is — uploads
  keep going straight to S3.
- [ ] Delete the `AvatarRewrite` function and the `/avatars/*` behaviour with the rest of the distribution in Phase 4.
- [ ] Replace `frontend.yml` with a caller, passing `permissions-policy: on-device-speech-recognition=self` and the
  `wss://poker-api[-env]` connect-src.

---

## Phase 3 — Cutover (1 day, spread across soak windows)

Per service, per environment, in the order dev → stage → prod. Never two environments of the same service on the same
day.

- [ ] Deploy the Worker through CI. Verify the **static** gates on its `workers.dev` URL first — no DNS involved.
  `verify.sh <url> <expected connect-src origins…>` covers them. The auth, CORS and WebSocket gates cannot pass there,
  because the page origin is not in `CORS_ALLOWED_ORIGINS`; they wait for the custom domain below.
- [ ] Attach the custom domain and let the certificate issue while the DNS record still points at CloudFront.
- [ ] Switch the DNS record to the Worker. Keep the proxy on.
- [ ] Verify, in this order: HTML `200` with the expected `content-security-policy`; a nested pretty URL; an unknown
  path returning `404`; login round trip and cookie set; one authenticated API call with its preflight. Run the Phase 0
  `verify.sh` from the plan's kit directory against the real hostname — it covers the first three mechanically.
- [ ] Record `curl -w '%{time_total}'` before and after the DNS switch. This, not `cf-cache-status`, is the evidence
  that the extra hop is gone; the header is documented as probabilistic on static assets.
- [ ] Poker only: an avatar loads from the API hostname and returns the immutable `Cache-Control` on the second
  request.
- [ ] Prod only, once the custom domain serves traffic: set `prod-workers-dev: false` in that repo's caller and
  redeploy, so `<service>-prod.workers.dev` stops being a second origin outside the zone.
- [ ] Soak: dev 1 day, stage 2 days, prod 1 week before its teardown is allowed.

**Rollback:** point the DNS record back at the CloudFront distribution, which is still deployed and still synced with
the last S3 state. No apply, no rebuild. Rollback for the poker avatar path is the previous `avatar-base-url` value plus
an instance refresh.

---

## Phase 4 — Teardown (1.5 days, only after prod soak)

- [ ] `ctech-poker`: confirm `AvatarsBucket` lives in its new stack and holds its objects, then delete `FrontendStack`.
- [ ] Delete `cdk/lib/frontend-stack.ts` and its `bin/` wiring in `account`, `dfe`, `poker`, `wallet`; deploy and
  confirm the distribution, KeyValueStore, CloudFront Function, OAC, response-headers policies and frontend bucket are
  gone.
- [ ] Keep production frontend buckets for one further week if their `RemovalPolicy` is `RETAIN` — they hold the last
  known-good export, which is the deepest rollback available. Delete them explicitly afterwards.
- [ ] `ctech-billing`: `terraform destroy` scoped to the frontend resources, then delete `frontend.tf`, the frontend
  parameters in `ssm.tf`, the frontend role in `iam.tf`, and the matching `outputs.tf` entries.
- [ ] Remove the frontend deploy roles: `ctech-{dfe,poker,wallet}-gha-frontend`, `ctech-account-github-deploy-role`'s
  frontend statements, and the frontend halves of `github-deploy-roles.ts` if nothing else uses them.
- [ ] Delete `lib/nextjs-static-frontend.ts` from `ctech-cdk`, its `lib/index.ts` export, and
  `cdk/test/frontend-stack.test.ts` in `dfe` and `poker`. Publish the new `@aoctech/cdk` version and bump the consumers.
- [ ] `ctech-lbalancer`: the `viewer -> Cloudflare -> CloudFront -> Cloudflare -> HAProxy` chain no longer exists.
  Review the client-IP resolution logic that exists to handle it and simplify only if the private M2M path stays
  correct. Optional; do not bundle it with the cutover.

---

## Phase 5 — Documentation (1 day)

- [ ] New ADR in each service repo: what moved, why, what the accepted limits are, and the rollback that was kept.
  Reference D1–D5 above.
- [ ] Amend `ctech-billing/docs/adr/0013-static-portal-same-origin-api.md` a second time: the static export half still
  stands, the distribution is gone, and the `/v1.0/*` behaviour that ADR kept as a rollback no longer exists.
- [ ] Rewrite every statement asserting that CloudFront forwards `/v1.0/*` or `/.well-known/*`:
  `ctech-account/ui/{CLAUDE,AGENTS,FRONTEND,GUIDELINES}.md`, `ctech-account/README.md:628,658,661`,
  `ctech-account/cdk/README.md:168`, `ctech-dfe/ui/next.config.ts` comment, `ctech-wallet/ui/next.config.ts` comment,
  `ctech-poker/ui/next.config.ts`, `ctech-billing/ui/next.config.ts` comment, and each repo's `DEPLOYMENT.md`.
- [ ] Record the Cloudflare token scope and rotation cadence in each repo's `DEPLOYMENT.md`.
- [ ] Update `_analysis/` with the duplication that this migration removed, so the audit does not keep reporting five
  copies of a script that no longer exists.

---

## Effort summary

| Phase               | Days                                              |
|---------------------|---------------------------------------------------|
| 0 — Spike           | 0.5 — done, gates passed                          |
| 1 — Shared workflow | 1.5–2                                             |
| 2a–2d — Four repos  | 2.0                                               |
| 2e — Poker avatars  | 0.5–1                                             |
| 3 — Cutover         | 1.0                                               |
| 4 — Teardown        | 1.5                                               |
| 5 — Documentation   | 1.0                                               |
| **Total**           | **8.5–9.5 dev-days, ~2 calendar weeks with soak** |

Net code change: roughly 1,000 lines deleted (217 construct + 371 frontend stacks + 362 route scripts + tests +
Terraform), roughly 150 added (one reusable workflow, five thin callers, one avatar handler).

---

## Risks

| Risk                                                                          | Mitigation                                                                             |
|-------------------------------------------------------------------------------|----------------------------------------------------------------------------------------|
| Long-lived Cloudflare token replaces an assumed role                          | One scoped token per repository, documented rotation, no account-wide scope            |
| A `_headers` mistake ships a weaker CSP than `ResponseHeadersPolicy` did      | Phase 0 diffs the served headers before and after; Phase 3 re-checks per environment   |
| Avatar read path pulls bytes through the `t4g.nano` before the cache warms    | Immutable cache headers, independent rate limit, CloudFront fallback documented in D2  |
| A file-count or file-size limit is hit only by the largest app                | Checked in Phase 0 against real `out/` directories, enforced as a job guard in Phase 1 |
| The DFE cross-origin flip breaks a call that was never exercised cross-origin | Flip on `dev` first and walk the app's mutating flows, including the WebSocket         |
| Third-party OIDC discovery at the issuer host                                 | Accepted (D1); the fix is an issuer move with a dual-accept window, not a proxy        |
