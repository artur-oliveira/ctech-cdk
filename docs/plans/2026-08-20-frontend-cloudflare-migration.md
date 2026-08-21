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

### 2a — `ctech-account` — caller done 2026-08-20

- [ ] Replace `.github/workflows/frontend.yml` with a caller passing `connect-src` for `accounts-api[-env]`,
  `viacep.com.br` and the KYC document bucket hostnames — the exact list currently produced by
  `contentSecurityPolicyDirectives` in `cdk/lib/frontend-stack.ts`.
- [ ] Confirm `NEXT_PUBLIC_API_URL` already points at `accounts-api[-env]` (it does) and that nothing in `ui/src`
  fetches a relative `/.well-known/*`.
- [ ] Confirm auth cookies still land: `Domain` comes from SSM `/ctech-account/{env}/cookie-domain` with `SameSite=Lax`,
  so a Cloudflare-served app on the same registrable domain is unaffected. Test the full login round trip on `dev`
  before touching stage.

### 2b — `ctech-billing` — caller done 2026-08-20

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

### 2d — `ctech-wallet` — code done 2026-08-20, **blocked on a pre-existing broken build**

- [x] Replace `frontend.yml` with a caller.
- [x] hreflang alternates. Not in `ui/src/app/layout.tsx` as this plan originally said — **that placement is wrong.**
  Next inherits metadata down the tree, so a `canonical: '/'` in the root layout would also claim to be the canonical
  of `/dashboard`, `/login`, `/callback` and `/gambling/*`, none of which declare metadata of their own. `/en` and
  `/pt-BR` already had correct per-page alternates via `lib/localized-metadata.ts`; the actual hole was `/`, which both
  of them name as `x-default` while naming nobody back — a one-way annotation a crawler discards. It only mattered once
  the CloudFront locale redirect went away and `/` became a served page. Fixed with `ROOT_ALTERNATES` on the root
  **page**, which required splitting the markup into `ui/src/components/home.tsx`: a page that exports `metadata`
  cannot be a client component. `/en` and `/pt-BR` keep re-exporting the same component, so there is one homepage.
- [x] `images: {unoptimized: true}` added to `ui/next.config.ts`. **Not cosmetic** — the homepage uses `next/image`,
  the default loader needs a server, and `output: 'export'` has none, so the export failed outright without it.
- [x] Confirmed against a real static export: `/`, `/en`, `/pt-BR` each prerender the right language
  (`Seu saldo CTech` / `Your CTech balance` / `Seu saldo CTech`), the three-way hreflang cluster is reciprocal in all
  three, and `out/dashboard.html` correctly carries no canonical and no alternates. `<html lang>` stays `pt-BR` in the
  static HTML on `/en` and is corrected on hydration by `StaticLocaleBoundary`, which also wraps the subtree in
  `<div lang="en">`; a nested layout cannot render `<html>`, so this is the only available fix and it predates the
  migration.
- [x] Tests: `homepage.test.mjs` and `ui-polish.test.mjs` repointed at `components/home.tsx`; new assertions in
  `homepage.test.mjs` and `localized-routes.test.mjs` for the root alternates. 45/45 node tests pass, `eslint` clean.
- [x] **The `wss://` CSP trap again, third repo out of three that has a socket.** `useWalletRealtime.ts` derived the
  socket origin from `NEXT_PUBLIC_API_URL` at runtime, so no `wss://` literal existed in the build environment for the
  generator to find. `connect-src` is scheme-exact, so **every wallet WebSocket would have been blocked the moment DNS
  moved.** Invisible under CloudFront because the socket was same-origin and covered by `'self'`. Fixed the same way as
  dfe and poker: explicit `NEXT_PUBLIC_WS_URL` per environment in the caller, read rather than derived, with the
  `NEXT_PUBLIC_API_URL` fallback kept for local development. Verified the generated prod `connect-src` is
  `'self' https://wallet-api.aoctech.app wss://wallet-api.aoctech.app https://accounts-api.aoctech.app`.
  `ctech-account` and `ctech-billing` have no WebSocket, so all three affected repos are now fixed.
- [x] Docs: `ui/CLAUDE.md`, `ui/README.md` and `ui/AGENTS.md` all asserted API access was **same-origin** and carried a
  rule reading "Never call the API cross-origin — keep `/v1.0/*` same-origin so CORS never applies." Directly contrary
  to this migration, and loaded into every future session in that repo. Replaced with the cross-origin reality, the
  `NEXT_PUBLIC_WS_URL` contract, and a rule that any new origin must appear as a literal in the caller's `build-env-*`.

### 2d.1 — `ctech-wallet` broken build, found by 2d and fixed 2026-08-20

`ctech-wallet/ui` **did not build at all** on `main`, migration or no migration: `src/lib/mock.ts:21` imported
`@/lib/utils/fee`, which does not exist — a hard module-resolution failure, so `next build` died before
type-checking, and `src/app/dashboard/page.tsx` read `w.fee` on a `Withdrawal` type with no such field. Introduced by
commit `406d432`. Wallet could deploy to neither Cloudflare nor CloudFront.

The repo's own `docs/specs/2026-08-16-withdrawal-fee-removal.md` (status: approved) settles it: "CTech never charges a
withdrawal fee… new code neither reads nor writes them." The Go API had already complied — no `FeeBps`/`FeeMin`/
`FeeMax`, no `json:"fee"`, no `fee` in the ledger entry-type constants. The UI was the leftover. So the fix is
deletion, not restoration:

- Dead code removed: the `withdrawalFee` call and `fee` ledger entry in `src/lib/mock.ts`; `fee: w.fee` and the two
  receipt rows (`confirm.fee`, `confirm.total` on `amount + fee`) in `dashboard/page.tsx` — with no fee the total
  equals the amount the receipt already shows; `fee?: number` and its validation branch in
  `lib/utils/transaction-status.ts`; the unreachable `item.fee != null` block in `transaction-status-list.tsx`; the
  test fixture's `fee: 100`. Old localStorage history still parses — `parseTransactionHistory` ignores unknown keys.
- **Copy that told users about a fee that does not exist**, in both locales: `confirm.fee`, `transactions.fee` and
  `ledger.type.fee` deleted; `confirm.withdraw.description` ("Review the amount and fee"),
  `transactions.guidance.processing` ("the amount and fee are returned") and `dialog.error.overWithdrawable`
  ("Including the fee, the maximum available to withdraw is X" — `effectiveMax` is just the balance, no fee
  subtracted) reworded. The four remaining "no fee" strings are about `real ↔ game` transfers and stay true.
- Docs corrected where they still asserted a fee or named deleted files: the root `CLAUDE.md`/`AGENTS.md` money-math
  paragraph and their "Fee calculation" test-table row, root `README.md`, `rpc-contract/README.md`, the B18 rows in
  `api/CLAUDE.md`/`api/AGENTS.md`/`api/ENDPOINTS.md`, and `ui/README.md`/`ui/AGENTS.md` — all four of the last group
  pointed at `ui/src/lib/utils/fee.ts` and `api/internal/domain/wallet/fee.go`, neither of which exists. Dated specs
  and plans from before 2026-08-16 are left as historical record; the removal spec already says it supersedes them.

**Now green:** `npx tsc --noEmit` clean, `eslint` clean, 45/45 node tests, and a real `NODE_ENV=production next build`
that completes with no stub. Verified in `out/`: the reciprocal hreflang cluster, no fee string anywhere in the
bundle, and — with `NEXT_PUBLIC_WS_URL` set as the caller sets it — exactly one `wss://wallet-api.aoctech.app`
literal, which is what makes the generated `connect-src` allow the socket.

### 2e — `ctech-poker` avatars — done 2026-08-20

The caller passes `csp-overrides: img-src 'self' data: $API_ORIGIN`. `$API_ORIGIN` is a new placeholder in the reusable
workflow that expands to the environment's `NEXT_PUBLIC_API_URL` origin — added because `csp-overrides` is one input
while the API host differs per environment, and hardcoding the prod host would have silently broken avatars on dev and
stage.

Also found while writing that caller: **Turnstile's script and iframe were never allowed by the CSP.**
`cdk/bin/poker.ts:137` passes `challenges.cloudflare.com` through `extraConnectSrc`, which only reaches `connect-src`.
The widget also needs it in `script-src`, and its iframe needs a `frame-src` — which fell back to `default-src 'self'`.
The caller now grants both. Pre-existing, not caused by this migration.

And a second CSP gap the caller had to close: the avatar **upload** is the one request the app makes to a host that is
not the API — `uploadAvatar()` POSTs the presigned form straight to the bucket (`ui/src/lib/avatar.ts`). The CDK
carried the bucket's two S3 origins in `extraConnectSrc` (`avatarsS3Origins`), but that is one value for all three
environments in the workflow and the bucket name carries the environment. It is passed as `AVATAR_UPLOAD_ORIGIN` in
each `build-env-*` block instead: nothing reads it (it is not `NEXT_PUBLIC_*`, so Next never inlines it), but the
generator derives `connect-src` from every `https://` origin in the build environment, so naming it there is what
allows the upload. Only the dualstack alias is listed — the API forces `UseDualStackEndpoint`
(`api/internal/app/app.go:242`) because poker instances have IPv6 egress only, so that is the only host a presigned
URL is ever issued for.

**Done:**

- [x] Public `GET /v1.0/avatars/:userId/:file` backed by `avatar.Service`, streamed with `SendStream`
  (`api/internal/api/v1/avatars.go`). Registered on the unauthenticated `/v1.0` group, above the `auth`-gated ones.
- [x] **Security:** `avatar.PublishedKey` / `avatar.UploadKey` are now the only way to build a key, and both refuse
  unless the user ID matches the UUID that ctech-account issues as `sub` and the version is positive. The prefix is not
  a caller's choice — it is the choice of which of the two functions to call — so `up/` is unaddressable from HTTP.
  `player.go` was switched over from its inline `fmt.Sprintf("up/%s/%d.jpg", …)`. Covered by
  `TestKeyBuildersRejectAnythingButAUUID`, `TestGetReadsOnlyThePublishedPrefix` and `TestPublicAvatarRead`, which
  assert that traversal, percent-encoded traversal, a non-UUID id, a non-`.jpg` name and version `≤ 0` all 404
  **without reaching S3 at all**.
- [x] `Cache-Control: public, max-age=31536000, immutable`, plus S3's `ETag` (the object's MD5 — a strong validator)
  and `X-Content-Type-Options: nosniff`. `Content-Type` is forced to `image/jpeg` rather than read from the object:
  `ValidateAndPublish` rewrites it on the copy into `av/`, so the stored value is not worth trusting.
  `If-None-Match` is deliberately **not** handled — keys are immutable and versioned, so no client ever revalidates.
- [x] A separate read limiter: 600/min/IP, against `avatarLimiter`'s 5/hour/player. One table view legitimately fetches
  nine images, and the route is unauthenticated, so it is keyed by IP.
- [x] 404 for missing/invalid, never a redirect (asserted: the response carries no `Location`). A genuine storage
  failure is **502**, not 404 — both render a broken image, but only one is worth paging on.
- [x] `AvatarsBucket` moved to a new `StorageStack` (`cdk/lib/storage-stack.ts`), same construct id and same physical
  name, with the CORS rule and the `up/` quarantine lifecycle rule unchanged. Not folded into `PokerApiStack`: that
  stack replaces instances on every release and a rollback there must not be able to reach user-uploaded content.
- [x] `s3:GetObject` on `av/*` added to the instance role — it replaces the CloudFront OAC that used to read the
  prefix. Asserted in `cdk/test/api-stack.test.ts`.
- [x] The `/avatars/*` behaviour, the `AvatarHeaders` policy and the `AvatarRewrite` CloudFront Function are already
  deleted from `FrontendStack` (they referenced the bucket). The rest of that stack still goes in Phase 4.

**Out of band, and in this order.** Neither is a CDK deploy, so a `cdk deploy` will not correct a stale value:

1. Adopt the existing bucket into `StorageStack`. In prod it is `RETAIN`, so removing it from `FrontendStack` orphans
   it rather than deleting it, and a plain deploy of `StorageStack` would then fail on the name already existing:

   ```
   cdk deploy CtechPoker-Prod-Frontend    # bucket leaves the stack, survives (RETAIN)
   cdk import CtechPoker-Prod-Storage     # adopt it: AvatarsBucket -> prod-ctech-poker-avatars
   ```

   In dev/stage the bucket is `DESTROY`/`autoDeleteObjects`, so it is simply deleted and recreated — no import, but
   deploy `Frontend` before `Storage` or the name is still taken.

2. Repoint the base URL. The parameter is provisioned out of band like every other one poker reads:

   ```
   aws ssm put-parameter --overwrite --type String \
     --name /ctech/prod/poker/avatar-base-url \
     --value https://poker-api.aoctech.app/v1.0/avatars
   ```

   Then refresh the ASG so `start.sh` re-reads it. Until that happens the API keeps serialising the old CloudFront
   URLs, which 404 the moment DNS moves. **This is the step that makes poker's cutover safe** — do it before Phase 3
   for poker, not after.

- [x] `frontend.yml` replaced with a caller, passing `permissions-policy: on-device-speech-recognition=self`.

**A third CSP gap, and the one that would have broken the most:** both realtime hooks derived the socket origin with
`(process.env.NEXT_PUBLIC_API_URL || window.location.origin).replace(/^http/, 'ws')`. Nothing in the build environment
then contains a `wss://` literal, so the generated `connect-src` would have carried `https://poker-api…` and not
`wss://poker-api…` — and `connect-src` is scheme-exact, so **every** WebSocket would have been blocked the moment DNS
moved. It did not show up under CloudFront because the socket rode the same-origin forward and `'self'` covered it.
Fixed the same way dfe was: `NEXT_PUBLIC_WS_URL` is now explicit per environment and read by a single `wsOrigin()`
helper (`ui/src/lib/ws/origin.ts`), which keeps the old derivation as the local-dev fallback. Both hooks call it, so
the two copies of that expression are gone and the value cannot drift from `NEXT_PUBLIC_API_URL` unnoticed.

Generated poker prod policy, verified against the workflow's own generator:

```
connect-src 'self' https://poker-api.aoctech.app wss://poker-api.aoctech.app
            https://accounts-api.aoctech.app
            https://prod-ctech-poker-avatars.s3.dualstack.us-east-1.amazonaws.com
            https://challenges.cloudflare.com
img-src 'self' data: https://poker-api.aoctech.app
script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com
frame-src https://challenges.cloudflare.com
```

---

## Phase 3 — Cutover (prod only)

**Done 2026-08-20 — all five services are on Workers.**

**Amended 2026-08-20 on the owner's instruction: no environment currently carries real traffic, so the cutover is done
directly in prod and the dev → stage → prod ladder is dropped.** Dev and stage Workers still get created whenever those
branches are pushed; they are simply not gates any more. Rollback is unchanged and still costs one DNS record.

### Cut over 2026-08-20 — `account`, `billing`, `dfe`, `wallet`

**The mechanism is a Worker Route, not a custom domain, and the two staging steps this plan described do not exist.**
The plan assumed the sequence "attach the custom domain, let the certificate issue while DNS still points at
CloudFront, then switch the DNS record". None of that applies to a hostname already in a Cloudflare zone: Universal SSL
had already issued, and attaching a *Custom Domain* would create or overwrite the DNS record — there is no window in
which the domain is attached but not yet serving. A **Worker Route** (`<host>/*`) binds the Worker to the existing
proxied record instead, so the record is never touched.

That is strictly better than what was planned. Rollback is `wrangler triggers deploy --name <worker>` with no
`--route`, or deleting the route in the dashboard: the DNS record still resolves to the CloudFront distribution, which
is still deployed and still holds the last S3 state. No DNS propagation on the way out.

It also folds in the last step for free: `wrangler triggers deploy` disables `workers_dev` when the Wrangler file does
not set it, so `<service>-prod.workers.dev` returned 404 the moment the route landed — verified on all four.

Per service, as actually run:

- [x] Deploy the prod Worker through CI (push to `main`). All four green; poker's Frontend job was skipped because its
  API job failed — see below.
- [x] Static gates on the `workers.dev` URL. `verify.sh` gained a `ROUTES` override, because its route list was dfe's
  and hardcoded. All four passed before any route was attached.
- [x] Attach the Worker Route, billing → dfe → wallet → account. `account` is last on purpose: it is the identity
  provider, so a broken frontend there breaks every login in the platform, not just its own.
- [x] Re-run the static gates against the **real hostname**. All four passed.
- [x] Record the latency. `time_starttransfer` on `/`, before → after:

  | host | CloudFront | Worker |
  |---|---|---|
  | `accounts.aoctech.app` | 1.221s | 0.482s |
  | `billing.aoctech.app`  | 1.171s | 0.402s |
  | `dfe.aoctech.app`      | 1.155s | 0.520s |
  | `wallet.aoctech.app`   | 0.942s (a 307 from the Function, not a page) | 0.700s |

  `x-amz-cf-id` and `x-cache` are absent from all four responses now, which is the direct evidence that the hop is
  gone; the timings are what it was worth.
- [x] `workers.dev` disabled — all four return 404. **Still to do in code:** set `prod-workers-dev: false` in each
  caller, or the next CI deploy re-enables it. The runtime state is correct; the declared state is not.
- [ ] The gates that need the real origin — login round trip and cookie, one authenticated request with its preflight,
  and the WebSocket for `dfe` and `wallet`. **Blocked until the ASG window (11:55–13:15 America/Sao_Paulo).** Every prod
  ASG sits at `DesiredCapacity=0` outside it, so all five API hosts answer 503 and no auth gate can run. Accepted: no
  environment carries real traffic, and rollback does not depend on the API.

**Two things confirmed during the cutover, both of which the migration was for:**

- `accounts.aoctech.app/.well-known/openid-configuration` now 404s and the API host serves it — the accepted
  OIDC-discovery limit, observed rather than assumed.
- An unknown path on `accounts` returned **200** during route propagation and **404** after. That 200 was CloudFront:
  its Function rewrote the miss to `/404.html` and S3 answered 200, so a crawler was told every mistyped URL was a
  page. `not_found_handling: 404-page` returns the same body with the right status.

### Gate cleared before the cutover — `ctech-account` CORS

`/ctech-account/prod/app-url` = `https://accounts.aoctech.app`, and `allowed-origins` already lists all five app hosts.
With `AllowCredentials` on and `APP_URL` prepended to the allowlist (`api/cmd/api/main.go:278`), the cross-origin
posture is correct for every service, not only account.

**Order matters for two services:**

- `ctech-poker` **cannot** cut over until 2e ships. The moment DNS points at the Worker, the `/avatars/*` CloudFront
  behaviour is out of the request path, and avatars 404 until the API serves them and `AVATAR_BASE_URL` is repointed.
- `ctech-wallet` should get its `hreflang` links first. Nothing breaks without them — `/`, `/en` and `/pt-BR` all render
  — but `/` stops redirecting by locale the moment the Function is out of the path, and the canonical links are what
  replace it.

### Cut over 2026-08-20 — `ctech-poker`, and the window 2e opened

Same mechanism as the other four: a Worker Route on `poker.aoctech.app/*`, no DNS change, rollback by dropping the
route. `prod-workers-dev: false` set in the caller; `ctech-poker-prod.aoctech.workers.dev` now 404s. All five services
are on Workers.

2e had already shipped when this ran — `GET /v1.0/avatars/{id}/{n}.jpg` returned `200 image/jpeg` with
`cache-control: public, max-age=31536000, immutable` and `cf-cache-status: HIT` — so the blocker recorded above was
already gone.

**2e left poker broken in prod, and only the cutover could fix it.** Repointing `AVATAR_BASE_URL` at the API host moved
avatars to a *different origin*, but `poker.aoctech.app` was still CloudFront, still serving the CDK
`ResponseHeadersPolicy` (`lib/nextjs-static-frontend.ts:115`) whose `img-src` is `'self' data:`. Every avatar was
blocked by CSP:

> Loading the image 'https://poker-api.aoctech.app/v1.0/avatars/…' violates the following Content Security Policy
> directive: "img-src 'self' data:". The action has been blocked.

The correct policy already existed — `csp-overrides: img-src 'self' data: $API_ORIGIN`
(`ctech-poker/.github/workflows/frontend.yml:69`) — but it is generated into `out/_headers` by the Worker pipeline, so
it only reached the browser on the Worker. Fixing it on CloudFront would have meant a `cdk deploy` of a stack Phase 4
deletes.

**The lesson for any future move of a static path onto an API host: the CSP that permits the new origin and the change
that starts using it must land in the same deploy.** Here they could not, because they live on opposite sides of the
migration — which is an argument for cutting over *before* repointing, not after.

### Gates that need the API, run 2026-08-20 with the ASG up outside its window

- **Preflight**: `OPTIONS /v1.0/health-check` with `Origin`, `Access-Control-Request-Method` and
  `Access-Control-Request-Headers` returns `204` on `poker-api` and `wallet-api`, with
  `access-control-allow-origin` echoing the app host, `access-control-allow-credentials: true` and
  `access-control-max-age: 3600`.
- **WebSocket**: the upgrade handshake with the app `Origin` returns `101` on `poker-api` and `wallet-api`.
  It must be sent over HTTP/1.1 — `curl` defaults to HTTP/2 against Cloudflare, which has no `Upgrade:` mechanism, and
  the attempt surfaces as a misleading `500`. `dfe` was verified separately and is fine; the `503` seen here was only
  its ASG already being back at zero.
- **Not covered by any of this:** the browser login round trip. It is the one gate that cannot be curled.

A latency complaint against poker's CORS did not reproduce. Ten requests over one connection: poker `0.20–0.34s`,
wallet `0.35–0.52s`. The CORS configuration is identical in both (`ctech-poker/api/internal/app/app.go:146`,
`ctech-wallet/api/internal/app/app.go:268`) down to `MaxAge: 3600`.

**Rejected: moving the access token into a cookie to drop `Authorization` and "avoid CORS".** It does not avoid CORS —
cross-origin still requires `Access-Control-Allow-Origin` and `Access-Control-Allow-Credentials`, plus
`withCredentials` on every call. It drops the *preflight*, and only for GET: poker's mutations send
`Content-Type: application/json` and `Idempotency-Key`, neither of which is a CORS-safelisted header, so they preflight
regardless. The gain is one `OPTIONS` per endpoint per hour, already bounded by `MaxAge`. The cost is losing CSRF
immunity — a bearer header cannot be forged by another origin, whereas a cookie is ambient authority, and
`SameSite=Lax` does not help here because the app and the API are *same-site*, so any `aoctech.app` subdomain could
forge an authenticated request. It would also end the in-memory-only access token (`ui/src/lib/api/client.ts:139`).
If preflight volume ever does matter, raise `MaxAge` to `7200` (Chrome's ceiling) and change nothing else.

**Rollback:** point the DNS record back at the CloudFront distribution, which is still deployed and still holds the last
S3 state. No apply, no rebuild. For poker's avatars, the previous `AVATAR_BASE_URL` value.

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

## Phase 5 — Documentation — docs sweep done 2026-08-20

Done ahead of Phase 3, not after it: every repo's `CLAUDE.md` requires the documentation in the same change as the
code, so the callers could not be committed while the docs next to them asserted the opposite.

- [x] **ADR, where the repo keeps ADRs.** Only `ctech-billing` does. `docs/adr/0020-portal-on-cloudflare-workers.md`
  supersedes the *hosting* half of 0013 — the same-origin half was already reversed by 0013's own amendment, and the
  static-export half still stands. 0013's header now says so and the index lists 0020. The other four repos have no ADR
  directory; their equivalent record is this plan, which they link.
- [x] **`ctech-account`** — every UI doc asserted "CloudFront forwards `/v1.0/*` and `/.well-known/*` … CORS never
  applies and cookies stay first-party", which is now false in all three clauses. Rewritten in
  `ui/{CLAUDE,AGENTS,FRONTEND,GUIDELINES,README}.md`, `README.md` (intro, the CDK resource list, and step 5 of the
  runbook, which still told the reader to set `NEXT_PUBLIC_API_URL=https://accounts.aoctech.app`), `cdk/README.md`
  (§ 6 now opens by saying nothing routes through the stack) and the stale `next.config.ts` comment.
- [x] **`ctech-billing`** — `ui/README.md` still documented `NEXT_PUBLIC_API_URL` as **empty**; the caller sets
  `https://billing-api.aoctech.app`. Also `ARCHITECTURE.md § 10`, `README.md` (the `frontend.tf` row, the `ui/` row, the
  ADR count, the checkout-manifest sentence), `PLAN.md`, `.github/workflows/README.md` (the `frontend.yml` row, the
  "Terraform first" reason, the fourth deploy identity, the DNS row) and the `next.config.ts` comment.
- [x] **`ctech-dfe`** — the UI docs said nothing about hosting at all, so nothing was wrong and nothing was right.
  `ui/{CLAUDE,AGENTS}.md` gained the Cloudflare/cross-origin paragraph and a `connect-src` rule; `ui/README.md` gained
  the same up top plus why `NEXT_PUBLIC_WS_URL` is not optional. `CONDUCT.md`'s "Edge routing (CloudFront in front of
  the HAProxy API origin)" section was rewritten end to end — it described a route manifest, a rewrite function and an
  `errorResponses` rule for machinery that no longer exists. `DOCS.md` and `OVERVIEW.md` corrected.
- [x] **Cloudflare token scope** recorded once, on the `secrets:` block of
  `ctech-cdk/.github/workflows/frontend-cloudflare.yml` — the one place all five callers read from, rather than five
  `DEPLOYMENT.md` copies of the same paragraph. Only `ctech-dfe` has a `DEPLOYMENT.md` at all, and it covers the API.
- [ ] Update `_analysis/` with the duplication that this migration removed, so the audit does not keep reporting five
  copies of a script that no longer exists.

### Found by the sweep — a Phase 3 gate for `ctech-account`

`APP_URL` is not only WebAuthn's RPID source. It is **prepended to the API's CORS allowlist**
(`api/cmd/api/main.go:278`), and `AllowCredentials` is on. Cross-origin only works if
`/ctech-account/prod/app-url` is exactly `https://accounts.aoctech.app`; if it is not, every call fails preflight the
moment DNS moves. Could not be verified from here — no AWS credentials in this session — so it is a gate to run before
the account cutover:

```bash
aws ssm get-parameters --region us-east-1 \
  --names /ctech-account/prod/app-url /ctech-account/prod/allowed-origins \
  --query 'Parameters[].[Name,Value]' --output text
```

The cookies themselves are fine and were checked in code: `ctech_rt` and `ctech_auth` are `SameSite=Lax`
(`api/internal/handler/helpers.go:106`), and `accounts.aoctech.app` / `accounts-api.aoctech.app` share the registrable
domain `aoctech.app` — cross-origin but **same-site**, so Lax is still sent. `withCredentials: true` is already set
(`ui/src/lib/axios.ts:16`). Removing either that flag or `AllowCredentials` breaks every refresh silently.

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
