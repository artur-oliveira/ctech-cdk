# Custom Alpine EC2 AMI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a Packer-built Alpine ARM64 AMI, a `ctech-ec2-agent` Go binary that
replaces `aws-cli` and the CloudWatch Agent, and a `ValkeyStackV2` that boots
from it — landing `ctech-cdk`'s side of the spec so the Valkey cutover and the
`ctech-billing` HAProxy pilot can run in prod.

**Architecture:** Extend the existing `Ec2ScriptsStack` content-hash publishing
pattern to also carry a new `assets/ec2-alpine/*.sh` script library and a
cross-compiled `ctech-ec2-agent` binary. A new Packer pipeline bakes an AMI from
Alpine's official AWS cloud image, installs the fixed apk package set plus the
agent, and publishes the AMI ID to SSM. `ValkeyStackV2` is a new stack, parallel
to `ValkeyStack`, that reads that AMI ID and the Alpine scripts instead of
AL2023's.

**Tech Stack:** AWS CDK (TypeScript), Packer (`amazon-ebs` builder), Alpine
Linux (musl/apk/OpenRC), Go 1.22+ (`ctech-ec2-agent`, `CGO_ENABLED=0`), AWS SDK
for Go v2, GitHub Actions.

**Spec:** `docs/specs/2026-08-23-alpine-ec2-ami.md`

## Global Constraints

- `amazon-ssm-agent` is mandatory on the AMI (Session Manager shell access and
  `send-command` deploys both depend on it) — never drop it to save space.
- `aws-cli` and the CloudWatch Agent are never installed on the Alpine AMI —
  `ctech-ec2-agent` replaces both, per spec §4.
- `rootVolumeGiB: 1` is the target on every Alpine launch template; the exact
  final number (1 or slightly more) is decided empirically in Task 13, not
  hardcoded ahead of measurement.
- No stack, construct, or exported symbol this plan touches changes its
  existing external contract for AL2023 consumers — `ValkeyStack` and
  `HaproxyEc2Service` keep working exactly as they do today. Everything new is
  additive and opt-in.
- The Packer/AMI-build IAM role is dedicated, never `ctech-gha-infra`
  (`AdministratorAccess`, reserved for this repo's own CDK deploys per
  `CLAUDE.md`).
- Every task that touches `lib/*.ts` ends with `npm test`, `npx tsc --noEmit`,
  and (where a stack changed) a `cdk synth` of the affected stack — per this
  repo's `CLAUDE.md` mandatory workflow.
- This plan covers `ctech-cdk` only. Actually migrating `ctech-billing`'s
  Terraform to consume `assets/ec2-alpine/*.sh` is a separate, cross-repo
  change — flagged in Task 13, not a task here.

---

## File Structure

New files:
- `assets/ctech-ec2-agent/` — Go module: `go.mod`, `main.go`, `ssm.go`,
  `prefixlist.go`, `route53.go`, `s3.go`, `logstail.go`, and `*_test.go` beside
  each.
- `assets/ec2-alpine/*.sh` — one script per `assets/ec2/*.sh` (except
  `setup-swap.sh`, which is reused unchanged), same argument contract.
- `packer/alpine-arm64.pkr.hcl` — the AMI build template.
- `.github/workflows/build-alpine-ami.yml` — Packer build workflow.
- `lib/ec2-userdata-fragments-alpine.ts` — Alpine-flavored equivalents of
  `lib/ec2-userdata-fragments.ts`.
- `lib/valkey-stack-v2.ts` — new stack, parallel to `lib/valkey-stack.ts`.
- `test/ctech-ec2-agent-scripts.test.ts` — parity tests for
  `assets/ec2-alpine/*.sh`, mirroring `test/ec2-scripts.test.ts`.
- `test/valkey-v2.test.ts` — mirrors `test/dragonfly.test.ts`'s synth-based
  style.
- `test/ec2-userdata-fragments-alpine.test.ts`.

Modified files:
- `CLAUDE.md` — fix the stale Dragonfly/Valkey claim; document the new pieces.
- `lib/types.ts`, `lib/constants.ts` — three new `SSM` entries.
- `lib/ec2-scripts-stack.ts` — publish two more content-hash prefixes.
- `lib/global-stack.ts` — add the Packer OIDC deploy role.
- `lib/index.ts` — export the new fragments module.
- `.github/workflows/ctech-cdk.yml` — cross-compile `ctech-ec2-agent` before
  `cdk deploy`.
- `.gitignore` — ignore the Go build output.
- `bin/ctech-cdk.ts` — add commented-out `ValkeyStackV2` wiring, ready for the
  cutover, matching how `DragonflyStack` is already staged there today.

---

## Task 1: Fix the CLAUDE.md Dragonfly/Valkey doc drift

Standalone documentation fix, unrelated to Alpine, found while reading this
area during brainstorming (spec, "Documentation" section).

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Read the current claim**

`CLAUDE.md` says under "Source of truth":

> `DragonflyStack`: shared EC2/ASG cache and pub/sub endpoint, replacing
> `ValkeyStack` while keeping its `/ctech/{env}/valkey/url` and
> `cache.internal.aoctech.app` contract;

`bin/ctech-cdk.ts` shows `DragonflyStack` commented out and `ValkeyStack`
active (commit `4ca03db`, "rollback valkey, there's no performance gain on
t4g.nano instances").

- [ ] **Step 2: Correct the bullet**

Replace the bullet with:

```markdown
- `ValkeyStack`: shared EC2/ASG cache and pub/sub endpoint (`t4g.nano`),
  publishing `/ctech/{env}/valkey/url` and `cache.internal.aoctech.app`.
  `DragonflyStack` (`lib/dragonfly-stack.ts`) exists but is not instantiated —
  rolled back, no measured performance gain on a `t4g.nano` (commit
  `4ca03db`). Do not re-enable it without re-measuring.
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: correct CLAUDE.md — Valkey is active, Dragonfly is not"
```

---

## Task 2: Add the three new SSM path groups

**Files:**
- Modify: `lib/types.ts`
- Modify: `lib/constants.ts`
- Test: `test/ec2-scripts.test.ts` (add cases alongside the existing
  `SSM.ec2Scripts` test)

**Interfaces:**
- Produces: `SSM.amiAlpine(env).arm64`, `SSM.ec2ScriptsAlpine(env).bucket`,
  `SSM.ec2ScriptsAlpine(env).version`, `SSM.ctechEc2Agent(env).bucket`,
  `SSM.ctechEc2Agent(env).version` — every later task that publishes or reads
  these paths uses these exact accessors.

- [ ] **Step 1: Write the failing tests**

Add to `test/ec2-scripts.test.ts`, next to the existing
`'SSM.ec2Scripts exposes the bucket and version paths'` test:

```typescript
test('SSM.amiAlpine exposes the arm64 AMI id path', () => {
  assert.equal(SSM.amiAlpine('prod').arm64, '/ctech/prod/ami/alpine/arm64');
});

test('SSM.ec2ScriptsAlpine exposes the bucket and version paths', () => {
  assert.equal(SSM.ec2ScriptsAlpine('prod').bucket, '/ctech/prod/ec2-scripts-alpine/bucket');
  assert.equal(SSM.ec2ScriptsAlpine('prod').version, '/ctech/prod/ec2-scripts-alpine/version');
});

test('SSM.ctechEc2Agent exposes the bucket and version paths', () => {
  assert.equal(SSM.ctechEc2Agent('prod').bucket, '/ctech/prod/ctech-ec2-agent/bucket');
  assert.equal(SSM.ctechEc2Agent('prod').version, '/ctech/prod/ctech-ec2-agent/version');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `SSM.amiAlpine is not a function` (and similarly for the other two).

- [ ] **Step 3: Add the types**

In `lib/types.ts`, add to the `SSMParams` interface (after `ec2Scripts`):

```typescript
  amiAlpine: (env: Environment) => {
    arm64: string;
  };
  ec2ScriptsAlpine: (env: Environment) => {
    bucket: string;
    version: string;
  };
  ctechEc2Agent: (env: Environment) => {
    bucket: string;
    version: string;
  };
```

- [ ] **Step 4: Add the constants**

In `lib/constants.ts`, add to the `SSM` object (after `ec2Scripts`):

```typescript
  // Published by the Packer AMI build workflow. Read by ValkeyStackV2 (and any
  // later Alpine consumer) via ec2.MachineImage.fromSsmParameter — a rebuilt
  // AMI only takes effect on that consumer's next `cdk deploy`, same as an
  // ec2-scripts change.
  amiAlpine: (env: string) => ({
    arm64: `/ctech/${env}/ami/alpine/arm64`,
  }),
  // Same content-hash publishing pattern as ec2Scripts, for assets/ec2-alpine.
  ec2ScriptsAlpine: (env: string) => ({
    bucket: `/ctech/${env}/ec2-scripts-alpine/bucket`,
    version: `/ctech/${env}/ec2-scripts-alpine/version`,
  }),
  // Same pattern again, for the compiled ctech-ec2-agent binary.
  ctechEc2Agent: (env: string) => ({
    bucket: `/ctech/${env}/ctech-ec2-agent/bucket`,
    version: `/ctech/${env}/ctech-ec2-agent/version`,
  }),
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test`
Expected: PASS

- [ ] **Step 6: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add lib/types.ts lib/constants.ts test/ec2-scripts.test.ts
git commit -m "feat: add SSM paths for the Alpine AMI, its scripts, and ctech-ec2-agent"
```

---

## Task 3: Scaffold `ctech-ec2-agent` — `ssm-get` and `ssm-put`

**Files:**
- Create: `assets/ctech-ec2-agent/go.mod`
- Create: `assets/ctech-ec2-agent/main.go`
- Create: `assets/ctech-ec2-agent/ssm.go`
- Test: `assets/ctech-ec2-agent/ssm_test.go`

**Interfaces:**
- Produces: `main()` dispatches `os.Args[1]` to `runSSMGet`, `runSSMPut`,
  `runPrefixList`, `runRoute53Upsert`, `runS3Cp`, `runS3Head`, `runLogsTail` —
  every later task in this repo adds one `case` and one `func run*(ctx
  context.Context, args []string) error`.
- Consumes: nothing from earlier tasks.

- [ ] **Step 1: Initialize the Go module**

```bash
mkdir -p assets/ctech-ec2-agent
cd assets/ctech-ec2-agent
go mod init github.com/artur-oliveira/ctech-cdk/assets/ctech-ec2-agent
go get github.com/aws/aws-sdk-go-v2/config@latest
go get github.com/aws/aws-sdk-go-v2/service/ssm@latest
```

- [ ] **Step 2: Write the failing test**

`assets/ctech-ec2-agent/ssm_test.go`:

```go
package main

import "testing"

func TestParseSSMGetArgsRequiresName(t *testing.T) {
	if _, err := parseSSMGetArgs([]string{}); err == nil {
		t.Fatal("expected an error when -name is missing")
	}
}

func TestParseSSMGetArgsDefaultsToDecrypt(t *testing.T) {
	args, err := parseSSMGetArgs([]string{"-name", "/ctech/prod/foo"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if args.name != "/ctech/prod/foo" {
		t.Fatalf("name = %q, want /ctech/prod/foo", args.name)
	}
	if !args.decrypt {
		t.Fatal("decrypt should default to true")
	}
}

func TestParseSSMPutArgsRequiresNameAndValue(t *testing.T) {
	if _, err := parseSSMPutArgs([]string{"-name", "/x"}); err == nil {
		t.Fatal("expected an error when -value is missing")
	}
}
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd assets/ctech-ec2-agent && go test ./...`
Expected: FAIL — `undefined: parseSSMGetArgs`

- [ ] **Step 4: Write `main.go`**

```go
package main

import (
	"context"
	"fmt"
	"os"
)

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: ctech-ec2-agent <subcommand> [flags]")
		os.Exit(1)
	}
	ctx := context.Background()
	cmd, args := os.Args[1], os.Args[2:]

	var err error
	switch cmd {
	case "ssm-get":
		err = runSSMGet(ctx, args)
	case "ssm-put":
		err = runSSMPut(ctx, args)
	default:
		err = fmt.Errorf("unknown subcommand %q", cmd)
	}
	if err != nil {
		fmt.Fprintf(os.Stderr, "ctech-ec2-agent %s: %v\n", cmd, err)
		os.Exit(1)
	}
}
```

- [ ] **Step 5: Write `ssm.go`**

```go
package main

import (
	"context"
	"flag"
	"fmt"
	"os"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/ssm"
	ssmtypes "github.com/aws/aws-sdk-go-v2/service/ssm/types"
)

type ssmGetArgs struct {
	name    string
	decrypt bool
}

func parseSSMGetArgs(args []string) (ssmGetArgs, error) {
	fs := flag.NewFlagSet("ssm-get", flag.ContinueOnError)
	name := fs.String("name", "", "SSM parameter name")
	decrypt := fs.Bool("decrypt", true, "decrypt SecureString parameters")
	if err := fs.Parse(args); err != nil {
		return ssmGetArgs{}, err
	}
	if *name == "" {
		return ssmGetArgs{}, fmt.Errorf("-name is required")
	}
	return ssmGetArgs{name: *name, decrypt: *decrypt}, nil
}

type ssmPutArgs struct {
	name  string
	value string
}

func parseSSMPutArgs(args []string) (ssmPutArgs, error) {
	fs := flag.NewFlagSet("ssm-put", flag.ContinueOnError)
	name := fs.String("name", "", "SSM parameter name")
	value := fs.String("value", "", "value to store")
	if err := fs.Parse(args); err != nil {
		return ssmPutArgs{}, err
	}
	if *name == "" || *value == "" {
		return ssmPutArgs{}, fmt.Errorf("-name and -value are required")
	}
	return ssmPutArgs{name: *name, value: *value}, nil
}

func newSSMClient(ctx context.Context) (*ssm.Client, error) {
	cfg, err := config.LoadDefaultConfig(ctx)
	if err != nil {
		return nil, fmt.Errorf("load AWS config: %w", err)
	}
	return ssm.NewFromConfig(cfg), nil
}

// runSSMGet writes the parameter value to stdout, unquoted, so callers can do
// VAR=$(ctech-ec2-agent ssm-get -name /path) — the same shape setup-ssm-env.sh
// already expects from `aws ssm get-parameter --query Parameter.Value --output text`.
func runSSMGet(ctx context.Context, argv []string) error {
	args, err := parseSSMGetArgs(argv)
	if err != nil {
		return err
	}
	client, err := newSSMClient(ctx)
	if err != nil {
		return err
	}
	out, err := client.GetParameter(ctx, &ssm.GetParameterInput{
		Name:           aws.String(args.name),
		WithDecryption: aws.Bool(args.decrypt),
	})
	if err != nil {
		return fmt.Errorf("get parameter %q: %w", args.name, err)
	}
	fmt.Fprint(os.Stdout, aws.ToString(out.Parameter.Value))
	return nil
}

func runSSMPut(ctx context.Context, argv []string) error {
	args, err := parseSSMPutArgs(argv)
	if err != nil {
		return err
	}
	client, err := newSSMClient(ctx)
	if err != nil {
		return err
	}
	_, err = client.PutParameter(ctx, &ssm.PutParameterInput{
		Name:      aws.String(args.name),
		Value:     aws.String(args.value),
		Type:      ssmtypes.ParameterTypeString,
		Overwrite: aws.Bool(true),
	})
	if err != nil {
		return fmt.Errorf("put parameter %q: %w", args.name, err)
	}
	return nil
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd assets/ctech-ec2-agent && go test ./...`
Expected: PASS

- [ ] **Step 7: Verify it cross-compiles for the target platform**

Run: `cd assets/ctech-ec2-agent && CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -o /tmp/ctech-ec2-agent-arm64 .`
Expected: builds with no errors (this is the exact invocation Task 7's CI step uses).

- [ ] **Step 8: Commit**

```bash
git add assets/ctech-ec2-agent
git commit -m "feat(ctech-ec2-agent): scaffold agent with ssm-get and ssm-put"
```

---

## Task 4: `ctech-ec2-agent` — `prefix-list` and `route53-upsert`

**Files:**
- Create: `assets/ctech-ec2-agent/prefixlist.go`
- Create: `assets/ctech-ec2-agent/route53.go`
- Test: `assets/ctech-ec2-agent/prefixlist_test.go`
- Test: `assets/ctech-ec2-agent/route53_test.go`
- Modify: `assets/ctech-ec2-agent/main.go` (add two `case`s)
- Modify: `assets/ctech-ec2-agent/go.mod` (two new SDK modules)

**Interfaces:**
- Consumes: nothing new from Task 3 beyond the `main()` dispatch shape.
- Produces: `runPrefixList`, `runRoute53Upsert` — same `func(ctx, []string) error` shape as Task 3's functions.

- [ ] **Step 1: Add the SDK modules**

```bash
cd assets/ctech-ec2-agent
go get github.com/aws/aws-sdk-go-v2/service/ec2@latest
go get github.com/aws/aws-sdk-go-v2/service/route53@latest
```

- [ ] **Step 2: Write the failing tests**

`assets/ctech-ec2-agent/prefixlist_test.go`:

```go
package main

import "testing"

func TestFilterCIDRsRejectsAPartialList(t *testing.T) {
	// setup-realip.sh's own rule: fewer than 10 entries means the AWS call
	// came back truncated or wrong — refuse rather than write a bad config.
	if err := validatePrefixCount(9); err == nil {
		t.Fatal("expected an error for fewer than 10 prefixes")
	}
	if err := validatePrefixCount(10); err != nil {
		t.Fatalf("10 prefixes must be accepted: %v", err)
	}
}
```

`assets/ctech-ec2-agent/route53_test.go`:

```go
package main

import "testing"

func TestParseRoute53UpsertArgsRequiresAllFields(t *testing.T) {
	_, err := parseRoute53UpsertArgs([]string{"-zone-id", "Z123"})
	if err == nil {
		t.Fatal("expected an error when -name and -value are missing")
	}
}

func TestParseRoute53UpsertArgsDefaultsTTL(t *testing.T) {
	args, err := parseRoute53UpsertArgs([]string{
		"-zone-id", "Z123", "-name", "cache.internal.aoctech.app", "-value", "10.0.0.5",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if args.ttl != 10 {
		t.Fatalf("ttl = %d, want default 10", args.ttl)
	}
}
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd assets/ctech-ec2-agent && go test ./...`
Expected: FAIL — `undefined: validatePrefixCount` / `undefined: parseRoute53UpsertArgs`

- [ ] **Step 4: Write `prefixlist.go`**

```go
package main

import (
	"context"
	"flag"
	"fmt"
	"os"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/ec2"
	ec2types "github.com/aws/aws-sdk-go-v2/service/ec2/types"
)

// A partial list is worse than a stale one: an unlisted edge would be treated
// as the client and become the rate-limit key. Mirrors setup-realip.sh's own
// "-lt 10" bail-out.
const minExpectedPrefixCount = 10

func validatePrefixCount(n int) error {
	if n < minExpectedPrefixCount {
		return fmt.Errorf("refusing a partial prefix list: got %d entries, want at least %d", n, minExpectedPrefixCount)
	}
	return nil
}

func runPrefixList(ctx context.Context, argv []string) error {
	fs := flag.NewFlagSet("prefix-list", flag.ContinueOnError)
	name := fs.String("name", "com.amazonaws.global.cloudfront.origin-facing", "managed prefix list name")
	region := fs.String("region", "us-east-1", "region the prefix list lives in (CloudFront's is global, in us-east-1)")
	if err := fs.Parse(argv); err != nil {
		return err
	}

	cfg, err := config.LoadDefaultConfig(ctx, config.WithRegion(*region))
	if err != nil {
		return fmt.Errorf("load AWS config: %w", err)
	}
	client := ec2.NewFromConfig(cfg)

	listOut, err := client.DescribeManagedPrefixLists(ctx, &ec2.DescribeManagedPrefixListsInput{
		Filters: []ec2types.Filter{{
			Name:   aws.String("prefix-list-name"),
			Values: []string{*name},
		}},
	})
	if err != nil {
		return fmt.Errorf("describe managed prefix lists: %w", err)
	}
	if len(listOut.PrefixLists) == 0 {
		return fmt.Errorf("managed prefix list %q not found", *name)
	}
	prefixListID := aws.ToString(listOut.PrefixLists[0].PrefixListId)

	entriesOut, err := client.GetManagedPrefixListEntries(ctx, &ec2.GetManagedPrefixListEntriesInput{
		PrefixListId: aws.String(prefixListID),
	})
	if err != nil {
		return fmt.Errorf("get managed prefix list entries for %s: %w", prefixListID, err)
	}
	if err := validatePrefixCount(len(entriesOut.Entries)); err != nil {
		return err
	}

	for _, e := range entriesOut.Entries {
		fmt.Fprintln(os.Stdout, aws.ToString(e.Cidr))
	}
	return nil
}
```

- [ ] **Step 5: Write `route53.go`**

```go
package main

import (
	"context"
	"flag"
	"fmt"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/route53"
	r53types "github.com/aws/aws-sdk-go-v2/service/route53/types"
)

type route53UpsertArgs struct {
	zoneID string
	name   string
	value  string
	ttl    int64
}

func parseRoute53UpsertArgs(argv []string) (route53UpsertArgs, error) {
	fs := flag.NewFlagSet("route53-upsert", flag.ContinueOnError)
	zoneID := fs.String("zone-id", "", "hosted zone id")
	name := fs.String("name", "", "record FQDN")
	value := fs.String("value", "", "record value (e.g. an IPv4 address)")
	ttl := fs.Int64("ttl", 10, "record TTL in seconds")
	if err := fs.Parse(argv); err != nil {
		return route53UpsertArgs{}, err
	}
	if *zoneID == "" || *name == "" || *value == "" {
		return route53UpsertArgs{}, fmt.Errorf("-zone-id, -name and -value are required")
	}
	return route53UpsertArgs{zoneID: *zoneID, name: *name, value: *value, ttl: *ttl}, nil
}

func runRoute53Upsert(ctx context.Context, argv []string) error {
	args, err := parseRoute53UpsertArgs(argv)
	if err != nil {
		return err
	}
	cfg, err := config.LoadDefaultConfig(ctx)
	if err != nil {
		return fmt.Errorf("load AWS config: %w", err)
	}
	client := route53.NewFromConfig(cfg)

	_, err = client.ChangeResourceRecordSets(ctx, &route53.ChangeResourceRecordSetsInput{
		HostedZoneId: aws.String(args.zoneID),
		ChangeBatch: &r53types.ChangeBatch{
			Changes: []r53types.Change{{
				Action: r53types.ChangeActionUpsert,
				ResourceRecordSet: &r53types.ResourceRecordSet{
					Name:            aws.String(args.name),
					Type:            r53types.RRTypeA,
					TTL:             aws.Int64(args.ttl),
					ResourceRecords: []r53types.ResourceRecord{{Value: aws.String(args.value)}},
				},
			}},
		},
	})
	if err != nil {
		return fmt.Errorf("upsert %s -> %s in zone %s: %w", args.name, args.value, args.zoneID, err)
	}
	return nil
}
```

- [ ] **Step 6: Wire the subcommands into `main.go`**

Add two cases to the `switch` in `main.go`:

```go
	case "prefix-list":
		err = runPrefixList(ctx, args)
	case "route53-upsert":
		err = runRoute53Upsert(ctx, args)
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `cd assets/ctech-ec2-agent && go test ./...`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add assets/ctech-ec2-agent
git commit -m "feat(ctech-ec2-agent): add prefix-list and route53-upsert"
```

---

## Task 5: `ctech-ec2-agent` — `s3-cp` and `s3-head`

**Files:**
- Create: `assets/ctech-ec2-agent/s3.go`
- Test: `assets/ctech-ec2-agent/s3_test.go`
- Modify: `assets/ctech-ec2-agent/main.go`
- Modify: `assets/ctech-ec2-agent/go.mod`

**Interfaces:**
- Produces: `runS3Cp`, `runS3Head`. `runS3Head` returns a distinguishable
  "not found" error via `errNotFound` (exported package-level sentinel) so
  `main()` can map it to exit code 1 without a stack trace — mirrors
  `aws s3api head-object`'s plain non-zero exit on a missing key, which
  `bootstrap-deploy.sh` already branches on.

- [ ] **Step 1: Add the SDK module**

```bash
cd assets/ctech-ec2-agent
go get github.com/aws/aws-sdk-go-v2/service/s3@latest
```

- [ ] **Step 2: Write the failing test**

`assets/ctech-ec2-agent/s3_test.go`:

```go
package main

import "testing"

func TestParseS3CpArgsRequiresAllFields(t *testing.T) {
	if _, err := parseS3CpArgs([]string{"-bucket", "b"}); err == nil {
		t.Fatal("expected an error when -key and -dest are missing")
	}
}

func TestParseS3HeadArgsRequiresBucketAndKey(t *testing.T) {
	if _, err := parseS3HeadArgs([]string{"-bucket", "b"}); err == nil {
		t.Fatal("expected an error when -key is missing")
	}
}
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd assets/ctech-ec2-agent && go test ./...`
Expected: FAIL — `undefined: parseS3CpArgs`

- [ ] **Step 4: Write `s3.go`**

```go
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	smithyhttp "github.com/aws/smithy-go/transport/http"
)

var errNotFound = errors.New("not found")

type s3CpArgs struct {
	bucket, key, dest string
}

func parseS3CpArgs(argv []string) (s3CpArgs, error) {
	fs := flag.NewFlagSet("s3-cp", flag.ContinueOnError)
	bucket := fs.String("bucket", "", "source bucket")
	key := fs.String("key", "", "source object key")
	dest := fs.String("dest", "", "local destination path")
	if err := fs.Parse(argv); err != nil {
		return s3CpArgs{}, err
	}
	if *bucket == "" || *key == "" || *dest == "" {
		return s3CpArgs{}, fmt.Errorf("-bucket, -key and -dest are required")
	}
	return s3CpArgs{bucket: *bucket, key: *key, dest: *dest}, nil
}

type s3HeadArgs struct {
	bucket, key string
}

func parseS3HeadArgs(argv []string) (s3HeadArgs, error) {
	fs := flag.NewFlagSet("s3-head", flag.ContinueOnError)
	bucket := fs.String("bucket", "", "bucket")
	key := fs.String("key", "", "object key")
	if err := fs.Parse(argv); err != nil {
		return s3HeadArgs{}, err
	}
	if *bucket == "" || *key == "" {
		return s3HeadArgs{}, fmt.Errorf("-bucket and -key are required")
	}
	return s3HeadArgs{bucket: *bucket, key: *key}, nil
}

func newS3Client(ctx context.Context) (*s3.Client, error) {
	cfg, err := config.LoadDefaultConfig(ctx)
	if err != nil {
		return nil, fmt.Errorf("load AWS config: %w", err)
	}
	return s3.NewFromConfig(cfg), nil
}

func runS3Cp(ctx context.Context, argv []string) error {
	args, err := parseS3CpArgs(argv)
	if err != nil {
		return err
	}
	client, err := newS3Client(ctx)
	if err != nil {
		return err
	}
	out, err := client.GetObject(ctx, &s3.GetObjectInput{
		Bucket: aws.String(args.bucket),
		Key:    aws.String(args.key),
	})
	if err != nil {
		return fmt.Errorf("get s3://%s/%s: %w", args.bucket, args.key, err)
	}
	defer out.Body.Close()

	f, err := os.Create(args.dest)
	if err != nil {
		return fmt.Errorf("create %s: %w", args.dest, err)
	}
	defer f.Close()

	if _, err := io.Copy(f, out.Body); err != nil {
		return fmt.Errorf("write %s: %w", args.dest, err)
	}
	return nil
}

// runS3Head returns errNotFound (never a raw AWS error) when the key is
// missing, so main() exits 1 without dumping a stack of SDK error wrapping —
// callers like bootstrap-deploy.sh only ever branch on the exit code.
func runS3Head(ctx context.Context, argv []string) error {
	args, err := parseS3HeadArgs(argv)
	if err != nil {
		return err
	}
	client, err := newS3Client(ctx)
	if err != nil {
		return err
	}
	_, err = client.HeadObject(ctx, &s3.HeadObjectInput{
		Bucket: aws.String(args.bucket),
		Key:    aws.String(args.key),
	})
	if err != nil {
		var respErr *smithyhttp.ResponseError
		if errors.As(err, &respErr) && respErr.HTTPStatusCode() == 404 {
			return errNotFound
		}
		return fmt.Errorf("head s3://%s/%s: %w", args.bucket, args.key, err)
	}
	return nil
}
```

- [ ] **Step 5: Wire the subcommands into `main.go`**, mapping `errNotFound` to a
  quiet exit 1 (no stderr noise — matches `aws s3api head-object`'s own
  behavior, which `bootstrap-deploy.sh` treats as "no artifact yet", not an
  error to log):

```go
	case "s3-cp":
		err = runS3Cp(ctx, args)
	case "s3-head":
		err = runS3Head(ctx, args)
```

And change the error-handling tail of `main()` to:

```go
	if err != nil {
		if errors.Is(err, errNotFound) {
			os.Exit(1)
		}
		fmt.Fprintf(os.Stderr, "ctech-ec2-agent %s: %v\n", cmd, err)
		os.Exit(1)
	}
```

(add `"errors"` to `main.go`'s imports)

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd assets/ctech-ec2-agent && go test ./...`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add assets/ctech-ec2-agent
git commit -m "feat(ctech-ec2-agent): add s3-cp and s3-head"
```

---

## Task 6: `ctech-ec2-agent` — `logs-tail`

The one genuinely new piece of logic (spec §4): tails one or more files,
survives rotation, batches, and ships to CloudWatch Logs. Kept deliberately
narrow — no multi-line grouping, no metrics.

**Files:**
- Create: `assets/ctech-ec2-agent/logstail.go`
- Test: `assets/ctech-ec2-agent/logstail_test.go`
- Modify: `assets/ctech-ec2-agent/main.go`
- Modify: `assets/ctech-ec2-agent/go.mod`

**Interfaces:**
- Produces: `runLogsTail(ctx, args) error`; `type logsTailConfig` (JSON shape
  read from `-config`); `loadCursor`/`saveCursor` (used only within this file,
  but named here because Task 8's `setup-ctech-ec2-agent.sh` writes the config
  file this function reads).
- Config file shape (written by `assets/ec2-alpine/setup-ctech-ec2-agent.sh` in
  Task 8):

```json
{
  "logGroup": "/ctech/prod/valkey",
  "files": [
    {"path": "/var/log/valkey/valkey.log", "streamPrefix": "valkey"}
  ]
}
```

- [ ] **Step 1: Add the SDK module**

```bash
cd assets/ctech-ec2-agent
go get github.com/aws/aws-sdk-go-v2/service/cloudwatchlogs@latest
```

- [ ] **Step 2: Write the failing tests**

`assets/ctech-ec2-agent/logstail_test.go` — covers the pure logic (rotation
detection, batching threshold) without touching AWS:

```go
package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestDetectRotationOnInodeChange(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "app.log")
	if err := os.WriteFile(path, []byte("first\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	st, err := statInode(path)
	if err != nil {
		t.Fatal(err)
	}

	// Simulate logrotate: rename the old file away, create a fresh one at the
	// same path. The inode must differ even though the path is identical.
	if err := os.Rename(path, path+".1"); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("second\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	st2, err := statInode(path)
	if err != nil {
		t.Fatal(err)
	}
	if st == st2 {
		t.Fatal("expected a different inode after rotation")
	}
}

func TestBatcherFlushesOnSizeThreshold(t *testing.T) {
	b := newBatcher(2, time.Hour) // huge interval: only size should trigger it
	if b.add("one") {
		t.Fatal("must not flush before the threshold")
	}
	if !b.add("two") {
		t.Fatal("must flush once the threshold is reached")
	}
	if len(b.drain()) != 2 {
		t.Fatal("drain must return everything added since the last drain")
	}
}

func TestBatcherFlushesOnInterval(t *testing.T) {
	b := newBatcher(1000, time.Millisecond)
	b.add("one")
	time.Sleep(5 * time.Millisecond)
	if !b.dueForFlush() {
		t.Fatal("must be due for flush once the interval elapses")
	}
}
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd assets/ctech-ec2-agent && go test ./...`
Expected: FAIL — `undefined: statInode` / `undefined: newBatcher`

- [ ] **Step 4: Write `logstail.go`**

```go
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"syscall"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/cloudwatchlogs"
	cwltypes "github.com/aws/aws-sdk-go-v2/service/cloudwatchlogs/types"
	"github.com/aws/smithy-go"
)

type logsTailFileConfig struct {
	Path         string `json:"path"`
	StreamPrefix string `json:"streamPrefix"`
}

type logsTailConfig struct {
	LogGroup string                `json:"logGroup"`
	Files    []logsTailFileConfig  `json:"files"`
}

func loadLogsTailConfig(path string) (logsTailConfig, error) {
	body, err := os.ReadFile(path)
	if err != nil {
		return logsTailConfig{}, fmt.Errorf("read config %s: %w", path, err)
	}
	var cfg logsTailConfig
	if err := json.Unmarshal(body, &cfg); err != nil {
		return logsTailConfig{}, fmt.Errorf("parse config %s: %w", path, err)
	}
	if cfg.LogGroup == "" || len(cfg.Files) == 0 {
		return logsTailConfig{}, fmt.Errorf("config %s must set logGroup and at least one file", path)
	}
	return cfg, nil
}

// statInode identifies a file by device+inode, which changes across a
// logrotate rename+recreate even when the path stays the same — the only
// reliable rotation signal without a filesystem-events dependency.
func statInode(path string) (uint64, error) {
	fi, err := os.Stat(path)
	if err != nil {
		return 0, err
	}
	sys, ok := fi.Sys().(*syscall.Stat_t)
	if !ok {
		return 0, fmt.Errorf("unsupported platform: no inode in os.FileInfo.Sys()")
	}
	return sys.Ino, nil
}

// batcher buffers lines until either count or a time interval is reached —
// PutLogEvents needs no sequence token (AWS removed that requirement in
// 2023), so a batcher only has to decide *when* to flush, never track state
// across calls.
type batcher struct {
	mu       sync.Mutex
	max      int
	interval time.Duration
	lines    []string
	since    time.Time
}

func newBatcher(max int, interval time.Duration) *batcher {
	return &batcher{max: max, interval: interval, since: time.Now()}
}

// add reports whether the batch just crossed its size threshold.
func (b *batcher) add(line string) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.lines = append(b.lines, line)
	return len(b.lines) >= b.max
}

func (b *batcher) dueForFlush() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	return len(b.lines) > 0 && time.Since(b.since) >= b.interval
}

func (b *batcher) drain() []string {
	b.mu.Lock()
	defer b.mu.Unlock()
	out := b.lines
	b.lines = nil
	b.since = time.Now()
	return out
}

// cursorPath derives a stable, filesystem-safe path from the watched file's
// own path, so a restart can find the right cursor without a lookup table.
func cursorPath(watched string) string {
	name := filepath.Base(watched) + "-" + strconv.FormatUint(uint64(len(watched)), 10)
	return filepath.Join("/var/lib/ctech-ec2-agent", name+".pos")
}

type cursor struct {
	Inode  uint64 `json:"inode"`
	Offset int64  `json:"offset"`
}

func loadCursor(watched string) cursor {
	body, err := os.ReadFile(cursorPath(watched))
	if err != nil {
		return cursor{}
	}
	var c cursor
	if json.Unmarshal(body, &c) != nil {
		return cursor{}
	}
	return c
}

func saveCursor(watched string, c cursor) error {
	if err := os.MkdirAll(filepath.Dir(cursorPath(watched)), 0o755); err != nil {
		return err
	}
	body, err := json.Marshal(c)
	if err != nil {
		return err
	}
	return os.WriteFile(cursorPath(watched), body, 0o644)
}

func streamName(prefix, instanceID string) string {
	return fmt.Sprintf("%s/%s", prefix, instanceID)
}

func ensureLogStream(ctx context.Context, client *cloudwatchlogs.Client, logGroup, stream string) error {
	_, err := client.CreateLogStream(ctx, &cloudwatchlogs.CreateLogStreamInput{
		LogGroupName:  aws.String(logGroup),
		LogStreamName: aws.String(stream),
	})
	if err == nil {
		return nil
	}
	var apiErr smithy.APIError
	if ok := aws.ErrorAs(err, &apiErr); ok && apiErr.ErrorCode() == "ResourceAlreadyExistsException" {
		return nil
	}
	return err
}

func flush(ctx context.Context, client *cloudwatchlogs.Client, logGroup, stream string, lines []string) error {
	if len(lines) == 0 {
		return nil
	}
	events := make([]cwltypes.InputLogEvent, 0, len(lines))
	now := time.Now().UnixMilli()
	for _, line := range lines {
		events = append(events, cwltypes.InputLogEvent{
			Message:   aws.String(line),
			Timestamp: aws.Int64(now),
		})
	}
	_, err := client.PutLogEvents(ctx, &cloudwatchlogs.PutLogEventsInput{
		LogGroupName:  aws.String(logGroup),
		LogStreamName: aws.String(stream),
		LogEvents:     events,
	})
	return err
}

// tailOne polls path for growth or rotation every pollInterval, batching
// lines and flushing them to CloudWatch Logs. It runs until ctx is canceled.
func tailOne(ctx context.Context, client *cloudwatchlogs.Client, logGroup, stream, path string, pollInterval time.Duration) error {
	c := loadCursor(path)
	b := newBatcher(100, 5*time.Second)

	for {
		select {
		case <-ctx.Done():
			return nil
		default:
		}

		inode, err := statInode(path)
		if err != nil {
			time.Sleep(pollInterval)
			continue
		}
		if inode != c.Inode {
			// Rotated (or first run): start from the top of the new file.
			c = cursor{Inode: inode, Offset: 0}
		}

		f, err := os.Open(path)
		if err != nil {
			time.Sleep(pollInterval)
			continue
		}
		if _, err := f.Seek(c.Offset, 0); err != nil {
			f.Close()
			time.Sleep(pollInterval)
			continue
		}

		scanner := bufio.NewScanner(f)
		read := int64(0)
		for scanner.Scan() {
			line := scanner.Text()
			read += int64(len(line)) + 1
			if b.add(line) {
				if err := flush(ctx, client, logGroup, stream, b.drain()); err != nil {
					f.Close()
					return fmt.Errorf("flush %s: %w", path, err)
				}
				c.Offset += read
				read = 0
				if err := saveCursor(path, c); err != nil {
					f.Close()
					return fmt.Errorf("save cursor for %s: %w", path, err)
				}
			}
		}
		c.Offset += read
		f.Close()
		if err := saveCursor(path, c); err != nil {
			return fmt.Errorf("save cursor for %s: %w", path, err)
		}

		if b.dueForFlush() {
			if err := flush(ctx, client, logGroup, stream, b.drain()); err != nil {
				return fmt.Errorf("flush %s: %w", path, err)
			}
		}

		time.Sleep(pollInterval)
	}
}

func runLogsTail(ctx context.Context, argv []string) error {
	fs := flag.NewFlagSet("logs-tail", flag.ContinueOnError)
	configPath := fs.String("config", "/etc/ctech-ec2-agent/logs.json", "path to the logs-tail JSON config")
	if err := fs.Parse(argv); err != nil {
		return err
	}
	cfg, err := loadLogsTailConfig(*configPath)
	if err != nil {
		return err
	}

	awsCfg, err := config.LoadDefaultConfig(ctx)
	if err != nil {
		return fmt.Errorf("load AWS config: %w", err)
	}
	client := cloudwatchlogs.NewFromConfig(awsCfg)

	instanceID, err := fetchInstanceID(ctx)
	if err != nil {
		return fmt.Errorf("fetch instance id from IMDS: %w", err)
	}

	var wg sync.WaitGroup
	errs := make(chan error, len(cfg.Files))
	for _, file := range cfg.Files {
		stream := streamName(file.StreamPrefix, instanceID)
		if err := ensureLogStream(ctx, client, cfg.LogGroup, stream); err != nil {
			return fmt.Errorf("create log stream %s: %w", stream, err)
		}
		wg.Add(1)
		go func(path, stream string) {
			defer wg.Done()
			if err := tailOne(ctx, client, cfg.LogGroup, stream, path, time.Second); err != nil {
				errs <- err
			}
		}(file.Path, stream)
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		return err
	}
	return nil
}
```

- [ ] **Step 5: Write `fetchInstanceID` (IMDSv2)**

Add to `assets/ctech-ec2-agent/main.go` (used by `logstail.go` above and
reusable later):

```go
func fetchInstanceID(ctx context.Context) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPut,
		"http://169.254.169.254/latest/api/token", nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("X-aws-ec2-metadata-token-ttl-seconds", "60")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("fetch IMDSv2 token: %w", err)
	}
	defer resp.Body.Close()
	token, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", err
	}

	req, err = http.NewRequestWithContext(ctx, http.MethodGet,
		"http://169.254.169.254/latest/meta-data/instance-id", nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("X-aws-ec2-metadata-token", string(token))
	resp2, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("fetch instance id: %w", err)
	}
	defer resp2.Body.Close()
	id, err := io.ReadAll(resp2.Body)
	if err != nil {
		return "", err
	}
	return string(id), nil
}
```

Add `"io"` and `"net/http"` to `main.go`'s imports.

- [ ] **Step 6: Wire `logs-tail` into `main.go`**

```go
	case "logs-tail":
		err = runLogsTail(ctx, args)
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `cd assets/ctech-ec2-agent && go test ./...`
Expected: PASS

- [ ] **Step 8: Verify `go vet` and the full cross-compile are clean**

Run: `cd assets/ctech-ec2-agent && go vet ./... && CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -o /tmp/ctech-ec2-agent-arm64 .`
Expected: no errors, builds a static ARM64 binary.

- [ ] **Step 9: Commit**

```bash
git add assets/ctech-ec2-agent
git commit -m "feat(ctech-ec2-agent): add logs-tail"
```

---

## Task 7: Wire `ctech-ec2-agent` into CI before `cdk deploy`

**Files:**
- Modify: `.github/workflows/ctech-cdk.yml`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: `assets/ctech-ec2-agent` (Tasks 3–6), built at
  `assets/ctech-ec2-agent/dist/ctech-ec2-agent`.
- Produces: that exact path — Task 9's `Ec2ScriptsStack` change reads it via
  `s3assets.Asset`.

- [ ] **Step 1: Ignore the build output**

Add to `.gitignore`:

```gitignore
assets/ctech-ec2-agent/dist/
```

- [ ] **Step 2: Add a build step to both jobs in `.github/workflows/ctech-cdk.yml`**

Insert this step right after `Install dependencies` in **both** the `diff` and
`deploy` jobs (CDK synth needs the binary on disk even for a diff, since
`s3assets.Asset` hashes whatever is there):

```yaml
      - uses: actions/setup-go@v5
        with:
          go-version: '1.22'

      - name: Build ctech-ec2-agent
        working-directory: assets/ctech-ec2-agent
        run: |
          mkdir -p dist
          CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -o dist/ctech-ec2-agent .
```

- [ ] **Step 3: Verify the workflow YAML is still valid**

Run: `cd /home/artur/Documents/Projects/Ctech/ctech-cdk && python3 -c "import yaml, sys; yaml.safe_load(open('.github/workflows/ctech-cdk.yml'))" 2>/dev/null || npx js-yaml .github/workflows/ctech-cdk.yml >/dev/null`
Expected: no error (either checker is fine — use whichever is available).

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/ctech-cdk.yml .gitignore
git commit -m "ci: cross-compile ctech-ec2-agent before every CDK diff/deploy"
```

---

## Task 8: Port the EC2 bootstrap scripts to Alpine/OpenRC

The largest mechanical task — one Alpine-flavored script per existing
AL2023/systemd script, per the spec §5/§6 mapping table.

**Files:**
- Create: `assets/ec2-alpine/setup-base.sh`
- Create: `assets/ec2-alpine/setup-app-service.sh`
- Create: `assets/ec2-alpine/setup-dualstack.sh`
- Create: `assets/ec2-alpine/setup-ctech-ec2-agent.sh`
- Create: `assets/ec2-alpine/setup-nginx.sh`
- Create: `assets/ec2-alpine/setup-realip.sh`
- Create: `assets/ec2-alpine/setup-cloudflare-ca.sh`
- Create: `assets/ec2-alpine/setup-ssm-env.sh`
- Create: `assets/ec2-alpine/setup-deploy.sh`
- Create: `assets/ec2-alpine/bootstrap-deploy.sh`
- (No `setup-swap.sh` — Task 9 points the Alpine bucket at the same
  `assets/ec2/setup-swap.sh`, since it is already OS-agnostic.)
- Test: `test/ec2-alpine-scripts.test.ts`

**Interfaces:**
- Every script keeps the exact same positional-argument contract as its
  `assets/ec2/*.sh` counterpart (see each script's header comment below) — the
  callers written in Tasks 10 and 12 rely on this.

- [ ] **Step 1: Write the failing parity tests**

`test/ec2-alpine-scripts.test.ts` (mirrors `test/ec2-scripts.test.ts`):

```typescript
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readdirSync, readFileSync} from 'node:fs';
import * as path from 'node:path';
import {test} from 'node:test';
import {SSM} from '../lib';

const ASSETS_DIR = path.join(__dirname, '..', 'assets', 'ec2-alpine');

const scriptNames = () => readdirSync(ASSETS_DIR).filter((f) => f.endsWith('.sh')).sort();

test('every Alpine EC2 asset script parses under bash', () => {
  const names = scriptNames();
  assert.ok(names.length > 0, 'expected at least one script in assets/ec2-alpine');
  for (const name of names) {
    execFileSync('bash', ['-n', path.join(ASSETS_DIR, name)], {stdio: 'pipe'});
  }
});

test('every Alpine EC2 asset script sets the strict shell options', () => {
  for (const name of scriptNames()) {
    const body = readFileSync(path.join(ASSETS_DIR, name), 'utf8');
    assert.match(body, /^#!\/bin\/bash$/m, `${name}: missing bash shebang`);
    assert.match(body, /^set -euo pipefail$/m, `${name}: missing set -euo pipefail`);
  }
});

test('no Alpine EC2 asset script uses systemd or dnf', () => {
  for (const name of scriptNames()) {
    const body = readFileSync(path.join(ASSETS_DIR, name), 'utf8');
    assert.doesNotMatch(body, /systemctl|journalctl/, `${name}: still calls systemd tooling`);
    assert.doesNotMatch(body, /\bdnf\b/, `${name}: still calls dnf`);
  }
});

test('setup-base.sh uses apk and adduser, and enables no cron unit AL2023 needed', () => {
  const body = readFileSync(path.join(ASSETS_DIR, 'setup-base.sh'), 'utf8');
  assert.match(body, /SERVICE="\$\{1:\?/);
  assert.match(body, /apk add --no-cache/);
  assert.match(body, /adduser -S -D -H -s \/sbin\/nologin webapp/);
});

test('setup-dualstack.sh writes OpenRC conf.d, not a systemd override', () => {
  const body = readFileSync(path.join(ASSETS_DIR, 'setup-dualstack.sh'), 'utf8');
  assert.match(body, /\/etc\/environment/);
  assert.match(body, /\/etc\/amazon\/ssm\/amazon-ssm-agent\.json/);
  assert.match(body, /\/etc\/conf\.d\/ctech-ec2-agent/);
  assert.doesNotMatch(body, /\.service\.d/);
});

test('setup-ctech-ec2-agent.sh installs the binary and starts the logs-tail service', () => {
  const body = readFileSync(path.join(ASSETS_DIR, 'setup-ctech-ec2-agent.sh'), 'utf8');
  assert.match(body, /CONFIG="\$\{1:\?/, 'logs-tail config path must be a required argument');
  assert.match(body, /rc-update add ctech-ec2-agent-logs default/);
  assert.match(body, /rc-service ctech-ec2-agent-logs start/);
});

test('setup-nginx.sh keeps both extension points and never double-includes realip', () => {
  const body = readFileSync(path.join(ASSETS_DIR, 'setup-nginx.sh'), 'utf8');
  assert.match(body, /include \/etc\/nginx\/conf\.d\/realip\*\.conf;/);
  assert.match(body, /include \/etc\/nginx\/conf\.d\/http-\*\.conf;/);
  assert.match(body, /include \/etc\/nginx\/conf\.d\/location-\*\.conf;/);
  assert.match(body, /include \/etc\/nginx\/conf\.d\/proxy-\*\.conf;/);
  assert.match(body, /rc-service nginx start/);
});

test('setup-realip.sh calls ctech-ec2-agent prefix-list, not the AWS CLI', () => {
  const body = readFileSync(path.join(ASSETS_DIR, 'setup-realip.sh'), 'utf8');
  assert.match(body, /VPC_CIDR="\$\{1:\?/);
  assert.match(body, /ctech-ec2-agent prefix-list/);
  assert.doesNotMatch(body, /\baws ec2\b/);
  assert.match(body, /RANDOM % 3600/, 'must jitter the daily periodic run itself, no systemd timer');
});

test('setup-cloudflare-ca.sh uses update-ca-certificates, not update-ca-trust', () => {
  const body = readFileSync(path.join(ASSETS_DIR, 'setup-cloudflare-ca.sh'), 'utf8');
  assert.match(body, /91a8a5567efa6bf941162aa806b3ba476aaddf7867640e53053b35fb225a5dae/);
  assert.match(body, /\/usr\/local\/share\/ca-certificates\//);
  assert.match(body, /update-ca-certificates/);
  assert.doesNotMatch(body, /update-ca-trust|\/etc\/pki\//);
});

test('setup-ssm-env.sh calls ctech-ec2-agent ssm-get, not the AWS CLI', () => {
  const body = readFileSync(path.join(ASSETS_DIR, 'setup-ssm-env.sh'), 'utf8');
  assert.match(body, /ctech-ec2-agent ssm-get/);
  assert.doesNotMatch(body, /aws ssm get-parameter/);
});

test('setup-deploy.sh calls ctech-ec2-agent s3-cp and reads the OpenRC log file, not journalctl', () => {
  const body = readFileSync(path.join(ASSETS_DIR, 'setup-deploy.sh'), 'utf8');
  assert.match(body, /ctech-ec2-agent s3-cp/);
  assert.match(body, /rc-service "\$unit" restart/);
  assert.doesNotMatch(body, /journalctl/);
});

test('bootstrap-deploy.sh calls ctech-ec2-agent s3-head, not the AWS CLI', () => {
  const body = readFileSync(path.join(ASSETS_DIR, 'bootstrap-deploy.sh'), 'utf8');
  assert.match(body, /ctech-ec2-agent s3-head/);
  assert.doesNotMatch(body, /s3api head-object/);
});

test('SSM path helpers used to publish this bucket exist', () => {
  assert.equal(SSM.ec2ScriptsAlpine('prod').bucket, '/ctech/prod/ec2-scripts-alpine/bucket');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `ENOENT: no such file or directory, scandir '.../assets/ec2-alpine'`

- [ ] **Step 3: Write `assets/ec2-alpine/setup-base.sh`**

```bash
#!/bin/bash
# Packages, the unprivileged service user, and the directory layout every
# CTech EC2 service shares — Alpine/apk equivalent of assets/ec2/setup-base.sh.
#
# Usage: setup-base.sh <service> [extra apk packages...]
#   setup-base.sh ctech-account nginx-openrc
set -euo pipefail

SERVICE="${1:?setup-base.sh: service name required}"
shift

apk add --no-cache amazon-ssm-agent amazon-ssm-agent-openrc unzip jq "$@"

# `adduser` returns 1 when the user already exists; the guard keeps a re-run
# green, same as the AL2023 script's useradd guard.
id -u webapp >/dev/null 2>&1 || adduser -S -D -H -s /sbin/nologin webapp

mkdir -p /opt/app/releases /var/log/app /etc/nginx/conf.d "/var/lib/$SERVICE"
chown -R webapp:webapp /opt/app /var/log/app "/var/lib/$SERVICE"

rc-update add amazon-ssm-agent default
rc-service amazon-ssm-agent start
```

- [ ] **Step 4: Write `assets/ec2-alpine/setup-app-service.sh`**

```bash
#!/bin/bash
# The OpenRC service and the launcher every CTech Go service shares — Alpine
# equivalent of assets/ec2/setup-app-service.sh. Same start.sh env-layering
# contract (release.env, then load-ssm-env.sh, then service-env.sh).
#
# Usage: setup-app-service.sh <description> <binary-name> [alt-port]
#   setup-app-service.sh "CTech Wallet API" app
#   setup-app-service.sh "CTech Wallet API" app 8081
set -euo pipefail

DESCRIPTION="${1:?setup-app-service.sh: unit description required}"
BINARY="${2:?setup-app-service.sh: binary name required}"
ALT_PORT="${3:-}"

mkdir -p /opt/app

cat > /opt/app/start.sh << 'START'
#!/bin/bash
# Generated by setup-app-service.sh — do not edit. Per-service configuration
# belongs in /opt/app/service-env.sh.
if [ -f /opt/app/current/release.env ]; then set -a; . /opt/app/current/release.env; set +a; fi
if [ -f /opt/app/load-ssm-env.sh ]; then . /opt/app/load-ssm-env.sh; fi
if [ -f /opt/app/service-env.sh ]; then . /opt/app/service-env.sh; fi
if [ -n "${PORT_OVERRIDE:-}" ]; then PORT="$PORT_OVERRIDE"; export PORT; fi
exec /opt/app/current/__BINARY__
START
sed -i "s|__BINARY__|${BINARY}|g" /opt/app/start.sh
chmod 0755 /opt/app/start.sh

cat > /etc/init.d/app << 'SVC'
#!/sbin/openrc-run
description="__DESCRIPTION__"
command="/opt/app/start.sh"
command_user="webapp:webapp"
command_background="yes"
pidfile="/run/app.pid"
supervisor="supervise-daemon"
respawn_delay=30
respawn_max=0
output_log="/var/log/app/app.log"
error_log="/var/log/app/app.log"

depend() {
	need net
}
SVC
sed -i "s|__DESCRIPTION__|${DESCRIPTION}|g" /etc/init.d/app
chmod 0755 /etc/init.d/app
rc-update add app default

if [ -n "$ALT_PORT" ]; then
  cat > /etc/init.d/app2 << 'SVC2'
#!/sbin/openrc-run
description="__DESCRIPTION__ (alt)"
command="/opt/app/start.sh"
command_user="webapp:webapp"
command_background="yes"
pidfile="/run/app2.pid"
supervisor="supervise-daemon"
respawn_delay=30
respawn_max=0
export PORT_OVERRIDE="__ALT_PORT__"
output_log="/var/log/app/app2.log"
error_log="/var/log/app/app2.log"

depend() {
	need net
}
SVC2
  sed -i \
    -e "s|__DESCRIPTION__|${DESCRIPTION}|g" \
    -e "s|__ALT_PORT__|${ALT_PORT}|g" \
    /etc/init.d/app2
  chmod 0755 /etc/init.d/app2
  rc-update add app2 default
  echo "$ALT_PORT" > /opt/app/alt-port
fi
```

- [ ] **Step 5: Write `assets/ec2-alpine/setup-dualstack.sh`**

```bash
#!/bin/bash
# These instances have no public IPv4. Alpine equivalent of
# assets/ec2/setup-dualstack.sh: the SSM agent's own config file plus
# ctech-ec2-agent's OpenRC conf.d (OpenRC services read /etc/conf.d/<name>,
# not /etc/environment, when started).
#
# Usage: setup-dualstack.sh
set -euo pipefail

grep -q '^AWS_USE_DUALSTACK_ENDPOINT=true$' /etc/environment \
  || echo "AWS_USE_DUALSTACK_ENDPOINT=true" >> /etc/environment

mkdir -p /etc/amazon/ssm
cat > /etc/amazon/ssm/amazon-ssm-agent.json << 'SSMCFG'
{ "Agent": { "UseDualStackEndpoint": true } }
SSMCFG
rc-service amazon-ssm-agent restart

mkdir -p /etc/conf.d
cat > /etc/conf.d/ctech-ec2-agent << 'AGENTENV'
export AWS_USE_DUALSTACK_ENDPOINT=true
AGENTENV
```

- [ ] **Step 6: Write `assets/ec2-alpine/setup-ctech-ec2-agent.sh`**

```bash
#!/bin/bash
# Installs ctech-ec2-agent and starts its logs-tail daemon under OpenRC.
# Replaces assets/ec2/setup-cloudwatch-agent.sh — logs only, per this
# repo's spec (docs/specs/2026-08-23-alpine-ec2-ami.md, non-goals: no metrics).
#
# Usage: setup-ctech-ec2-agent.sh <config-file>
#   setup-ctech-ec2-agent.sh /tmp/ctech-logs.json
set -euo pipefail

CONFIG="${1:?setup-ctech-ec2-agent.sh: logs-tail config file path required}"

test -s "$CONFIG" || { echo "setup-ctech-ec2-agent.sh: $CONFIG is missing or empty" >&2; exit 1; }

mkdir -p /etc/ctech-ec2-agent /var/lib/ctech-ec2-agent
install -m 0644 "$CONFIG" /etc/ctech-ec2-agent/logs.json

cat > /etc/init.d/ctech-ec2-agent-logs << 'SVC'
#!/sbin/openrc-run
description="ctech-ec2-agent logs-tail"
command="/usr/local/bin/ctech-ec2-agent"
command_args="logs-tail -config /etc/ctech-ec2-agent/logs.json"
command_background="yes"
pidfile="/run/ctech-ec2-agent-logs.pid"
supervisor="supervise-daemon"
respawn_delay=15
respawn_max=0

depend() {
	need net
	after amazon-ssm-agent
}
SVC
chmod 0755 /etc/init.d/ctech-ec2-agent-logs

rc-update add ctech-ec2-agent-logs default
rc-service ctech-ec2-agent-logs start
```

- [ ] **Step 7: Write `assets/ec2-alpine/setup-nginx.sh`**

```bash
#!/bin/bash
# Alpine/OpenRC equivalent of assets/ec2/setup-nginx.sh. The nginx.conf body
# is byte-for-byte the same (nginx's config format doesn't change with the
# OS) — only install/enable at the bottom differ.
#
# Usage: setup-nginx.sh <nginx-port> <app-port> <health-path> [rate-per-second] [max-body] [app-port-alt]
set -euo pipefail

NGINX_PORT="${1:?setup-nginx.sh: nginx listen port required}"
APP_PORT="${2:?setup-nginx.sh: app upstream port required}"
HEALTH_PATH="${3:?setup-nginx.sh: health check path required}"
RATE="${4:-100}"
MAX_BODY="${5:-1m}"
APP_PORT_ALT="${6:-}"

mkdir -p /etc/nginx/conf.d

cat > /etc/nginx/nginx.conf << 'NGINX'
user nginx;
pid /run/nginx.pid;
worker_processes auto;
worker_rlimit_nofile 65535;
error_log /var/log/nginx/error.log warn;

events {
    worker_connections 8192;
    use epoll;
    multi_accept on;
}

http {
    include /etc/nginx/mime.types;
    default_type application/octet-stream;

    include /etc/nginx/conf.d/realip*.conf;

    log_format json_log escape=json '{"remote_addr":"$remote_addr","status":$status,"request":"$request","body_bytes_sent":$body_bytes_sent,"request_time":$request_time,"upstream_response_time":"$upstream_response_time"}';

    sendfile on;
    tcp_nopush on;
    tcp_nodelay on;
    keepalive_timeout 30;
    keepalive_requests 10000;
    reset_timedout_connection on;
    open_file_cache max=1000 inactive=20s;
    open_file_cache_valid 30s;
    open_file_cache_min_uses 2;
    open_file_cache_errors on;

    types_hash_max_size 2048;
    types_hash_bucket_size 128;

    client_header_timeout 15s;
    client_body_timeout 30s;
    send_timeout 30s;

    client_max_body_size __MAX_BODY__;
    client_body_buffer_size 128k;
    client_header_buffer_size 1k;
    large_client_header_buffers 4 8k;

    gzip on;
    gzip_vary on;
    gzip_proxied any;
    gzip_comp_level 5;
    gzip_min_length 1024;
    gzip_types application/json application/problem+json application/javascript text/plain text/css;

    server_tokens off;
    proxy_hide_header X-Powered-By;
    add_header X-Content-Type-Options nosniff always;
    add_header X-Frame-Options DENY always;
    add_header Referrer-Policy strict-origin-when-cross-origin always;

    limit_req_zone $binary_remote_addr zone=req_by_ip:10m rate=__RATE__r/s;
    limit_conn_zone $binary_remote_addr zone=conn_by_ip:10m;
    limit_req_status  429;
    limit_conn_status 429;

    map $http_upgrade $connection_upgrade {
        default upgrade;
        ''      "";
    }

    include /etc/nginx/conf.d/http-*.conf;

    upstream app {
        server 127.0.0.1:__APP_PORT__;
__APP_PORT_ALT_LINE__
        keepalive 256;
        keepalive_requests 10000;
        keepalive_timeout 60s;
    }

    server {
        listen __NGINX_PORT__ default_server reuseport;
        server_name _;
        access_log /var/log/nginx/access.log json_log;
        error_log /var/log/nginx/error.log;

        include /etc/nginx/conf.d/location-*.conf;

        location = __HEALTH_PATH__ {
            proxy_pass http://app;
            proxy_http_version 1.1;
            proxy_set_header Connection "";
            proxy_set_header Host $host;
            proxy_connect_timeout 5s;
            proxy_read_timeout 5s;
            access_log off;
        }

        location / {
            limit_req  zone=req_by_ip burst=200 nodelay;
            limit_conn conn_by_ip 100;
            include /etc/nginx/conf.d/proxy-*.conf;

            proxy_pass http://app;
            proxy_http_version 1.1;
            proxy_set_header Connection "";
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $remote_addr;
            proxy_set_header X-Forwarded-Proto $http_x_forwarded_proto;
            proxy_connect_timeout 10s;
            proxy_send_timeout 60s;
            proxy_read_timeout 60s;
            proxy_buffering on;
            proxy_buffer_size 8k;
            proxy_buffers 16 16k;
            proxy_busy_buffers_size 32k;
        }
    }
}
NGINX

sed -i \
  -e "s|__NGINX_PORT__|${NGINX_PORT}|g" \
  -e "s|__APP_PORT__|${APP_PORT}|g" \
  -e "s|__HEALTH_PATH__|${HEALTH_PATH}|g" \
  -e "s|__RATE__|${RATE}|g" \
  -e "s|__MAX_BODY__|${MAX_BODY}|g" \
  /etc/nginx/nginx.conf

if [ -n "$APP_PORT_ALT" ]; then
  sed -i "s|__APP_PORT_ALT_LINE__|        server 127.0.0.1:${APP_PORT_ALT};|" /etc/nginx/nginx.conf
  mkdir -p /opt/app
  echo "$APP_PORT" > /opt/app/app-port
else
  sed -i "/__APP_PORT_ALT_LINE__/d" /etc/nginx/nginx.conf
fi

nginx -t

rc-update add nginx default
rc-service nginx start
```

- [ ] **Step 8: Write `assets/ec2-alpine/setup-realip.sh`**

```bash
#!/bin/bash
# Alpine/OpenRC equivalent of assets/ec2/setup-realip.sh. Same trust-chain
# reasoning (walk X-Forwarded-For right-to-left, discard only HAProxy then
# CloudFront's origin-facing ranges) — only the AWS call and the scheduling
# mechanism differ: ctech-ec2-agent instead of the AWS CLI, /etc/periodic
# instead of a systemd timer (OpenRC has no timer unit, so the daily script
# jitters its own start with `sleep $((RANDOM % 3600))`).
#
# Usage: setup-realip.sh <vpc-ipv4-cidr>
set -euo pipefail

VPC_CIDR="${1:?setup-realip.sh: VPC IPv4 CIDR required}"

mkdir -p /opt/app /etc/nginx/conf.d /etc/periodic/daily

cat > /opt/app/update-realip.sh << 'REALIP'
#!/bin/bash
set -euo pipefail
CONF=/etc/nginx/conf.d/realip.conf
TMP=$(mktemp)
export AWS_USE_DUALSTACK_ENDPOINT=true
PREFIXES=$(ctech-ec2-agent prefix-list -name com.amazonaws.global.cloudfront.origin-facing -region us-east-1)
if [ "$(echo "$PREFIXES" | grep -c .)" -lt 10 ]; then
  echo "Refusing to write realip.conf: only $(echo "$PREFIXES" | grep -c .) CloudFront prefixes returned" >&2
  exit 1
fi
{
  echo "# Generated by /opt/app/update-realip.sh — do not edit."
  echo "set_real_ip_from __VPC_CIDR__;"
  echo "$PREFIXES" | sed -e 's|^|set_real_ip_from |' -e 's|$|;|'
  echo "real_ip_header X-Forwarded-For;"
  echo "real_ip_recursive on;"
} > "$TMP"
install -m 644 "$TMP" "$CONF"
rm -f "$TMP"
if ! nginx -t 2>/dev/null; then
  echo "nginx rejected the generated realip.conf — reverting" >&2
  rm -f "$CONF"
  exit 1
fi
if rc-service nginx status >/dev/null 2>&1; then
  rc-service nginx reload
fi
REALIP
sed -i "s|__VPC_CIDR__|${VPC_CIDR}|g" /opt/app/update-realip.sh
chmod +x /opt/app/update-realip.sh

cat > /etc/periodic/daily/ctech-realip << 'PERIODIC'
#!/bin/bash
# Alpine has no RandomizedDelaySec — jitter the run itself so every instance
# in an ASG doesn't hit the AWS API in the same second.
sleep $((RANDOM % 3600))
/opt/app/update-realip.sh
PERIODIC
chmod +x /etc/periodic/daily/ctech-realip

/opt/app/update-realip.sh || echo "realip bootstrap failed — rate limiting will key on HAProxy until the next daily run"
```

- [ ] **Step 9: Write `assets/ec2-alpine/setup-cloudflare-ca.sh`**

```bash
#!/bin/bash
# Trusts the Cloudflare Origin CA RSA root — Alpine equivalent of
# assets/ec2/setup-cloudflare-ca.sh. Alpine's trust-store mechanism differs
# from RHEL's, not just the package manager: `update-ca-certificates` reading
# /usr/local/share/ca-certificates/, not `update-ca-trust`/`/etc/pki/`.
#
# Usage: setup-cloudflare-ca.sh
set -euo pipefail

CA_URL="https://developers.cloudflare.com/ssl/static/origin_ca_rsa_root.pem"
CA_SHA256="91a8a5567efa6bf941162aa806b3ba476aaddf7867640e53053b35fb225a5dae"
ANCHOR=/usr/local/share/ca-certificates/cloudflare-origin-ca-rsa.crt

command -v curl >/dev/null || apk add --no-cache curl
command -v openssl >/dev/null || apk add --no-cache openssl
apk add --no-cache ca-certificates

install -d -m 0755 /usr/local/share/ca-certificates

TMP="$(mktemp /tmp/cloudflare-origin-ca-rsa.XXXXXX.pem)"
trap 'rm -f "$TMP"' EXIT

curl --fail --silent --show-error --location \
  --retry 5 --retry-all-errors --connect-timeout 10 --max-time 60 \
  "$CA_URL" --output "$TMP"

echo "$CA_SHA256  $TMP" | sha256sum -c -
openssl x509 -in "$TMP" -noout -checkend 86400

rm -f /usr/local/share/ca-certificates/cloudflare-origin-ca-ecc.crt
install -m 0644 "$TMP" "$ANCHOR"

update-ca-certificates
```

- [ ] **Step 10: Write `assets/ec2-alpine/setup-ssm-env.sh`**

```bash
#!/bin/bash
# Generates /opt/app/load-ssm-env.sh from VAR=/ssm/path pairs. Alpine
# equivalent of assets/ec2/setup-ssm-env.sh: reads via ctech-ec2-agent
# ssm-get instead of the AWS CLI, same read-at-start contract.
#
# Usage: setup-ssm-env.sh VAR=/ssm/path [VAR=/ssm/path ...]
set -euo pipefail

OUT=/opt/app/load-ssm-env.sh

[ "$#" -gt 0 ] || { echo "setup-ssm-env.sh: at least one VAR=/ssm/path pair required" >&2; exit 1; }

for pair in "$@"; do
  case "$pair" in
    *=/*) ;;
    *) echo "setup-ssm-env.sh: expected VAR=/ssm/path, got '$pair'" >&2; exit 1 ;;
  esac
done

mkdir -p /opt/app
{
  echo '# Generated by setup-ssm-env.sh — do not edit.'
  echo '_ctech_ssm(){ ctech-ec2-agent ssm-get -name "$1" 2>/dev/null || echo ""; }'
  for pair in "$@"; do
    name="${pair%%=*}"
    ssm_path="${pair#*=}"
    printf '%s=$(_ctech_ssm %q)\n' "$name" "$ssm_path"
  done
} > "$OUT"
chmod 0644 "$OUT"
```

- [ ] **Step 11: Write `assets/ec2-alpine/setup-deploy.sh`**

```bash
#!/bin/bash
# Installs /opt/app/deploy.sh, invoked by SSM RunCommand with the release key.
# Alpine equivalent of assets/ec2/setup-deploy.sh: ctech-ec2-agent s3-cp
# instead of the AWS CLI, rc-service instead of systemctl, and the app's own
# log file instead of journalctl (OpenRC has no unified journal).
#
# Usage: setup-deploy.sh <deployments-bucket> <binary-name> <health-url> [extra binaries...]
set -euo pipefail

BUCKET="${1:?setup-deploy.sh: deployments bucket required}"
BINARY="${2:?setup-deploy.sh: binary name required}"
HEALTH_URL="${3:?setup-deploy.sh: health check URL required}"
shift 3
BINARIES="$BINARY $*"

mkdir -p /opt/app/releases

cat > /opt/app/deploy.sh << 'DEPLOY'
#!/bin/bash
set -euo pipefail

S3_KEY="${1:?deploy.sh: S3 key required}"
RELEASE_DIR="/opt/app/releases/$(date +%Y%m%d_%H%M%S)"
mkdir -p "$RELEASE_DIR"

echo "Downloading release: $S3_KEY"
ctech-ec2-agent s3-cp -bucket __BUCKET__ -key "$S3_KEY" -dest /tmp/release.zip
unzip -o /tmp/release.zip -d "$RELEASE_DIR"
for b in __BINARIES__; do chmod +x "$RELEASE_DIR/$b"; done
chown -R webapp:webapp "$RELEASE_DIR"
ln -sfT "$RELEASE_DIR" /opt/app/current

restart_and_wait() {
  local unit="$1" url="$2" log="$3"
  rc-service "$unit" restart
  for _ in {1..60}; do
    if curl -sf "$url" >/dev/null; then
      echo "$unit: health check passed"
      return 0
    fi
    if ! rc-service "$unit" status >/dev/null 2>&1; then
      echo "$unit: application failed to start"
      tail -n 100 "$log" || true
      exit 1
    fi
    sleep 2
  done
  curl -sf "$url" >/dev/null || { echo "$unit: timed out waiting for health check"; exit 1; }
}

if [ -f /opt/app/alt-port ]; then
  APP_PORT="$(cat /opt/app/app-port)"
  ALT_PORT="$(cat /opt/app/alt-port)"
  HEALTH_PATH="$(echo "__HEALTH_URL__" | sed -E 's#^[a-z]+://[^/]+##')"
  restart_and_wait app "http://127.0.0.1:${APP_PORT}${HEALTH_PATH}" /var/log/app/app.log
  restart_and_wait app2 "http://127.0.0.1:${ALT_PORT}${HEALTH_PATH}" /var/log/app/app2.log
else
  restart_and_wait app "__HEALTH_URL__" /var/log/app/app.log
fi

ls -dt /opt/app/releases/*/ 2>/dev/null | tail -n +2 | xargs rm -rf 2>/dev/null || true
echo "Deployment successful"
DEPLOY

sed -i \
  -e "s|__BUCKET__|${BUCKET}|g" \
  -e "s|__BINARIES__|${BINARIES}|g" \
  -e "s|__HEALTH_URL__|${HEALTH_URL}|g" \
  /opt/app/deploy.sh

chmod 0755 /opt/app/deploy.sh
```

- [ ] **Step 12: Write `assets/ec2-alpine/bootstrap-deploy.sh`**

```bash
#!/bin/bash
# Deploys the current release on first boot if one has already been
# published. Alpine equivalent of assets/ec2/bootstrap-deploy.sh:
# ctech-ec2-agent s3-head instead of `aws s3api head-object`.
#
# Usage: bootstrap-deploy.sh <deployments-bucket> <key>
set -euo pipefail

BUCKET="${1:?bootstrap-deploy.sh: deployments bucket required}"
KEY="${2:?bootstrap-deploy.sh: artifact key required}"

if ctech-ec2-agent s3-head -bucket "$BUCKET" -key "$KEY" >/dev/null 2>&1; then
  /opt/app/deploy.sh "$KEY"
else
  echo "No bootstrap artifact at s3://${BUCKET}/${KEY} — waiting for first deploy"
fi
```

- [ ] **Step 13: Run tests to verify they pass**

Run: `npm test`
Expected: PASS

- [ ] **Step 14: Shellcheck every new script (matches the repo's existing bash-parses-clean bar)**

Run: `shellcheck assets/ec2-alpine/*.sh || true` (report only — the existing
`assets/ec2/*.sh` scripts aren't shellcheck-clean either; note any new
warning that looks real, don't block on style-only ones).

- [ ] **Step 15: Commit**

```bash
git add assets/ec2-alpine test/ec2-alpine-scripts.test.ts
git commit -m "feat: port EC2 bootstrap scripts to Alpine/OpenRC"
```

---

## Task 9: Extend `Ec2ScriptsStack` to publish the Alpine scripts and the agent

**Files:**
- Modify: `lib/ec2-scripts-stack.ts`
- Test: `test/ec2-scripts.test.ts` (extend the existing synth test)

**Interfaces:**
- Consumes: `SSM.ec2ScriptsAlpine`, `SSM.ctechEc2Agent` (Task 2);
  `assets/ec2-alpine/*.sh` (Task 8); `assets/ctech-ec2-agent/dist/` (Task 7 —
  must exist on disk before `cdk synth`/`cdk deploy`/`npm test` run, since
  `s3assets.Asset` reads it directly).
- Produces: `Ec2ScriptsStack.alpineScriptsVersion`, `Ec2ScriptsStack.agentVersion`
  (new public readonly fields, alongside the existing `version`).

- [ ] **Step 1: Write the failing test**

Add to `test/ec2-scripts.test.ts`, right after the existing
`'Ec2ScriptsStack publishes the scripts under a content-hash prefix'` test:

```typescript
test('Ec2ScriptsStack also publishes the Alpine scripts and the ctech-ec2-agent binary', () => {
  const app = new cdk.App();
  const stack = new Ec2ScriptsStack(app, 'AlpineScriptsFixture', {
    env: {account: '111111111111', region: 'us-east-1'},
    environment: 'prod',
  });
  const template = Template.fromStack(stack);

  template.hasResourceProperties('Custom::CDKBucketDeployment', {
    DestinationBucketKeyPrefix: stack.alpineScriptsVersion,
    Prune: false,
  });
  template.hasResourceProperties('Custom::CDKBucketDeployment', {
    DestinationBucketKeyPrefix: stack.agentVersion,
    Prune: false,
  });

  template.hasResourceProperties('AWS::SSM::Parameter', {
    Name: '/ctech/prod/ec2-scripts-alpine/version',
    Value: stack.alpineScriptsVersion,
  });
  template.hasResourceProperties('AWS::SSM::Parameter', {
    Name: '/ctech/prod/ec2-scripts-alpine/bucket',
    Value: 'prod-ctech-ec2-scripts',
  });
  template.hasResourceProperties('AWS::SSM::Parameter', {
    Name: '/ctech/prod/ctech-ec2-agent/version',
    Value: stack.agentVersion,
  });
  template.hasResourceProperties('AWS::SSM::Parameter', {
    Name: '/ctech/prod/ctech-ec2-agent/bucket',
    Value: 'prod-ctech-ec2-scripts',
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `stack.alpineScriptsVersion is undefined`

- [ ] **Step 3: Ensure the agent binary exists before this test runs**

Run once, locally, so `npm test` has something to hash (CI already does this
in Task 7's workflow step):

```bash
cd assets/ctech-ec2-agent && mkdir -p dist && CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -o dist/ctech-ec2-agent . && cd ../..
```

- [ ] **Step 4: Extend `lib/ec2-scripts-stack.ts`**

Add two more asset uploads to the same bucket, reusing the existing bucket
variable. Insert after the existing `PublishScripts` `BucketDeployment` block:

```typescript
    // ── Alpine scripts (same content-hash publishing pattern) ────────────────
    const alpineAsset = new s3assets.Asset(this, 'AlpineScriptsAsset', {
      path: path.join(__dirname, '..', 'assets', 'ec2-alpine'),
    });
    this.alpineScriptsVersion = alpineAsset.assetHash;

    new s3deploy.BucketDeployment(this, 'PublishAlpineScripts', {
      sources: [s3deploy.Source.bucket(alpineAsset.bucket, alpineAsset.s3ObjectKey)],
      destinationBucket: bucket,
      destinationKeyPrefix: this.alpineScriptsVersion,
      prune: false,
      retainOnDelete: true,
    });

    new ssm.StringParameter(this, 'AlpineScriptsBucketParam', {
      parameterName: SSM.ec2ScriptsAlpine(environment).bucket,
      stringValue: bucketName,
      description: 'Bucket holding the Alpine EC2 bootstrap scripts',
    });
    new ssm.StringParameter(this, 'AlpineScriptsVersionParam', {
      parameterName: SSM.ec2ScriptsAlpine(environment).version,
      stringValue: this.alpineScriptsVersion,
      description: 'Content hash and S3 key prefix of the current Alpine bootstrap scripts',
    });

    // ── ctech-ec2-agent binary (same pattern again) ───────────────────────────
    const agentAsset = new s3assets.Asset(this, 'CtechEc2AgentAsset', {
      path: path.join(__dirname, '..', 'assets', 'ctech-ec2-agent', 'dist'),
    });
    this.agentVersion = agentAsset.assetHash;

    new s3deploy.BucketDeployment(this, 'PublishCtechEc2Agent', {
      sources: [s3deploy.Source.bucket(agentAsset.bucket, agentAsset.s3ObjectKey)],
      destinationBucket: bucket,
      destinationKeyPrefix: this.agentVersion,
      prune: false,
      retainOnDelete: true,
    });

    new ssm.StringParameter(this, 'CtechEc2AgentBucketParam', {
      parameterName: SSM.ctechEc2Agent(environment).bucket,
      stringValue: bucketName,
      description: 'Bucket holding the ctech-ec2-agent binary',
    });
    new ssm.StringParameter(this, 'CtechEc2AgentVersionParam', {
      parameterName: SSM.ctechEc2Agent(environment).version,
      stringValue: this.agentVersion,
      description: 'Content hash and S3 key prefix of the current ctech-ec2-agent build',
    });
```

And declare the two new public fields alongside the existing `version`:

```typescript
  public readonly alpineScriptsVersion: string;
  public readonly agentVersion: string;
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test`
Expected: PASS

- [ ] **Step 6: Type-check and synth**

Run: `npx tsc --noEmit`
Run: `ENVIRONMENT=dev npx cdk synth Ctech-Dev-Ec2Scripts --no-bundling` (or
whatever the actual stack id resolves to in `bin/ctech-cdk.ts`)
Expected: no errors; inspect the synthesized template for the two new
`AWS::SSM::Parameter` resources and two `Custom::CDKBucketDeployment`s.

- [ ] **Step 7: Commit**

```bash
git add lib/ec2-scripts-stack.ts test/ec2-scripts.test.ts
git commit -m "feat: publish the Alpine scripts and ctech-ec2-agent through Ec2ScriptsStack"
```

---

## Task 10: `lib/ec2-userdata-fragments-alpine.ts`

Parallel to `lib/ec2-userdata-fragments.ts` — CDK callers compose Alpine
userData from these instead. `HaproxyEc2Service` itself is unchanged (spec §6:
no new construct, it already takes `machineImage`/`rootVolumeGiB`).

**Files:**
- Create: `lib/ec2-userdata-fragments-alpine.ts`
- Modify: `lib/index.ts` (export it)
- Test: `test/ec2-userdata-fragments-alpine.test.ts`

**Interfaces:**
- Produces: `addDualStackSsmAgentCommandsAlpine`, `addCloudflareOriginCaCommandsAlpine`
  — same `(userData: ec2.UserData) => void` shape as their AL2023 counterparts
  in `lib/ec2-userdata-fragments.ts`, so a caller swaps the import, not the
  call site. `addSwapCommands` is **not** duplicated — it is already
  OS-agnostic and is re-exported as-is from the existing module (spec §5).

- [ ] **Step 1: Write the failing tests**

`test/ec2-userdata-fragments-alpine.test.ts`:

```typescript
import assert from 'node:assert/strict';
import {test} from 'node:test';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import {
  addCloudflareOriginCaCommandsAlpine,
  addDualStackSsmAgentCommandsAlpine,
} from '../lib/ec2-userdata-fragments-alpine';

test('addDualStackSsmAgentCommandsAlpine writes the OpenRC-restart form, not systemctl', () => {
  const userData = ec2.UserData.forLinux();
  addDualStackSsmAgentCommandsAlpine(userData);
  const rendered = userData.render();
  assert.match(rendered, /AWS_USE_DUALSTACK_ENDPOINT=true/);
  assert.match(rendered, /\/etc\/amazon\/ssm\/amazon-ssm-agent\.json/);
  assert.match(rendered, /rc-service amazon-ssm-agent restart/);
  assert.doesNotMatch(rendered, /systemctl/);
});

test('addCloudflareOriginCaCommandsAlpine uses update-ca-certificates', () => {
  const userData = ec2.UserData.forLinux();
  addCloudflareOriginCaCommandsAlpine(userData);
  const rendered = userData.render();
  assert.match(rendered, /origin_ca_rsa_root\.pem/);
  assert.match(rendered, /91a8a5567efa6bf941162aa806b3ba476aaddf7867640e53053b35fb225a5dae/);
  assert.match(rendered, /update-ca-certificates/);
  assert.doesNotMatch(rendered, /update-ca-trust/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module '../lib/ec2-userdata-fragments-alpine'`

- [ ] **Step 3: Write `lib/ec2-userdata-fragments-alpine.ts`**

```typescript
import * as ec2 from 'aws-cdk-lib/aws-ec2';

const CLOUDFLARE_ORIGIN_CA_RSA_URL =
  'https://developers.cloudflare.com/ssl/static/origin_ca_rsa_root.pem';
const CLOUDFLARE_ORIGIN_CA_RSA_SHA256 =
  '91a8a5567efa6bf941162aa806b3ba476aaddf7867640e53053b35fb225a5dae';

/**
 * Alpine/OpenRC equivalents of lib/ec2-userdata-fragments.ts. `addSwapCommands`
 * is not duplicated here — it is already OS-agnostic, import it from
 * ec2-userdata-fragments.ts as-is.
 */

/** OpenRC equivalent of addDualStackSsmAgentCommands. */
export function addDualStackSsmAgentCommandsAlpine(userData: ec2.UserData): void {
  userData.addCommands(
    'echo "AWS_USE_DUALSTACK_ENDPOINT=true" >> /etc/environment',
    `mkdir -p /etc/amazon/ssm`,
    `cat > /etc/amazon/ssm/amazon-ssm-agent.json << 'SSM'`,
    `{ "Agent": { "UseDualStackEndpoint": true } }`,
    `SSM`,
    'rc-service amazon-ssm-agent restart',
  );
}

/** Alpine's trust store: update-ca-certificates, not RHEL's update-ca-trust. */
export function addCloudflareOriginCaCommandsAlpine(userData: ec2.UserData): void {
  userData.addCommands(
    '(',
    '  set -euo pipefail',
    '  command -v curl >/dev/null || apk add --no-cache curl',
    '  command -v openssl >/dev/null || apk add --no-cache openssl',
    '  install -d -m 0755 /usr/local/share/ca-certificates',
    '  CF_ORIGIN_CA_TMP="$(mktemp /tmp/cloudflare-origin-ca-rsa.XXXXXX.pem)"',
    `  trap 'rm -f "$CF_ORIGIN_CA_TMP"' EXIT`,
    `  curl --fail --silent --show-error --location --retry 5 --retry-all-errors --connect-timeout 10 --max-time 60 "${CLOUDFLARE_ORIGIN_CA_RSA_URL}" --output "$CF_ORIGIN_CA_TMP"`,
    `  echo "${CLOUDFLARE_ORIGIN_CA_RSA_SHA256}  $CF_ORIGIN_CA_TMP" | sha256sum -c -`,
    '  openssl x509 -in "$CF_ORIGIN_CA_TMP" -noout -checkend 86400',
    '  rm -f /usr/local/share/ca-certificates/cloudflare-origin-ca-ecc.crt',
    '  install -m 0644 "$CF_ORIGIN_CA_TMP" /usr/local/share/ca-certificates/cloudflare-origin-ca-rsa.crt',
    ') || { echo "Cloudflare Origin CA RSA installation failed" >&2; exit 1; }',
    'update-ca-certificates || exit 1',
  );
}
```

- [ ] **Step 4: Export it from `lib/index.ts`**

Add:

```typescript
export {
  addCloudflareOriginCaCommandsAlpine,
  addDualStackSsmAgentCommandsAlpine,
} from './ec2-userdata-fragments-alpine';
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test`
Expected: PASS

- [ ] **Step 6: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add lib/ec2-userdata-fragments-alpine.ts lib/index.ts test/ec2-userdata-fragments-alpine.test.ts
git commit -m "feat: add Alpine equivalents of the shared EC2 userdata fragments"
```

---

## Task 11: Packer template, build workflow, and the dedicated IAM role

**Files:**
- Create: `packer/alpine-arm64.pkr.hcl`
- Create: `.github/workflows/build-alpine-ami.yml`
- Modify: `lib/global-stack.ts` (Packer OIDC deploy role)
- Test: `test/global-stack.test.ts` (new file, or extend an existing
  global-stack test if one exists — check first)

**Interfaces:**
- Produces: the AMI ID published to `SSM.amiAlpine(env).arm64` (Task 2's
  path), for Task 12's `ValkeyStackV2` to read.

- [ ] **Step 1: Check for an existing global-stack test file**

Run: `ls test/ | grep -i global`

If one exists, add to it in Step 6 below instead of creating a new file.

- [ ] **Step 2: Write `packer/alpine-arm64.pkr.hcl`**

```hcl
packer {
  required_plugins {
    amazon = {
      version = ">= 1.3.0"
      source  = "github.com/hashicorp/amazon"
    }
  }
}

variable "region" {
  type    = string
  default = "us-east-1"
}

variable "ctech_ec2_agent_source" {
  type        = string
  description = "s3://bucket/key of the ctech-ec2-agent binary to bake in, read from SSM by the calling workflow"
}

source "amazon-ebs" "alpine_arm64" {
  region        = var.region
  instance_type = "t4g.nano"
  ami_name      = "ctech-alpine-arm64-{{timestamp}}"
  ami_description = "CTech Alpine ARM64 base image — amazon-ssm-agent + ctech-ec2-agent, no aws-cli, no CloudWatch Agent"

  # Alpine's own official AWS cloud image, ARM64, most recent stable release.
  # See https://alpinelinux.org/cloud/ for the current owner/name pattern.
  source_ami_filter {
    filters = {
      name                = "alpine-*-aarch64-uefi-cloudinit-r0"
      architecture        = "arm64"
      virtualization-type = "hvm"
      root-device-type    = "ebs"
    }
    owners      = ["538276064493"] # Alpine Linux's AWS account
    most_recent = true
  }

  ssh_username    = "alpine"
  ami_virtualization_type = "hvm"

  launch_block_device_mappings {
    device_name = "/dev/xvda"
    volume_size = 2 # build-time only; consumer stacks set their own rootVolumeGiB
    volume_type = "gp3"
    delete_on_termination = true
  }
}

build {
  sources = ["source.amazon-ebs.alpine_arm64"]

  provisioner "shell" {
    inline = [
      "sudo apk update",
      "sudo apk add --no-cache amazon-ssm-agent amazon-ssm-agent-openrc",
      "sudo rc-update add amazon-ssm-agent default",
    ]
  }

  provisioner "shell" {
    inline = [
      "sudo mkdir -p /usr/local/bin",
    ]
  }

  provisioner "file" {
    source      = "ctech-ec2-agent"
    destination = "/tmp/ctech-ec2-agent"
  }

  provisioner "shell" {
    inline = [
      "sudo install -m 0755 /tmp/ctech-ec2-agent /usr/local/bin/ctech-ec2-agent",
    ]
  }
}
```

(The workflow in Step 3 downloads the built `ctech-ec2-agent` binary from S3
to a local file named `ctech-ec2-agent` in the working directory before
running `packer build`, so the `file` provisioner above finds it.)

- [ ] **Step 3: Write `.github/workflows/build-alpine-ami.yml`**

```yaml
name: Build Alpine AMI

on:
  workflow_dispatch:
    inputs:
      environment:
        description: 'Environment whose ctech-ec2-agent build to bake in (dev, stage, prod)'
        required: true
        default: 'dev'

permissions:
  id-token: write
  contents: read

jobs:
  build:
    name: Packer build
    runs-on: ubuntu-26.04-arm
    steps:
      - uses: actions/checkout@v6

      - name: Configure AWS credentials
        uses: aws-actions/configure-aws-credentials@v6
        with:
          role-to-assume: arn:aws:iam::868899309401:role/ctech-gha-packer
          aws-region: us-east-1

      - name: Resolve ctech-ec2-agent location
        id: agent
        run: |
          BUCKET=$(aws ssm get-parameter --name "/ctech/${{ inputs.environment }}/ctech-ec2-agent/bucket" --query Parameter.Value --output text)
          VERSION=$(aws ssm get-parameter --name "/ctech/${{ inputs.environment }}/ctech-ec2-agent/version" --query Parameter.Value --output text)
          echo "bucket=$BUCKET" >> "$GITHUB_OUTPUT"
          echo "version=$VERSION" >> "$GITHUB_OUTPUT"

      - name: Download ctech-ec2-agent
        run: |
          aws s3 cp "s3://${{ steps.agent.outputs.bucket }}/${{ steps.agent.outputs.version }}/ctech-ec2-agent" ./packer/ctech-ec2-agent
          chmod +x ./packer/ctech-ec2-agent

      - uses: hashicorp/setup-packer@v3
        with:
          version: latest

      - name: Packer init
        working-directory: packer
        run: packer init alpine-arm64.pkr.hcl

      - name: Packer build
        id: build
        working-directory: packer
        run: |
          packer build -machine-readable alpine-arm64.pkr.hcl | tee build.log
          AMI_ID=$(grep 'artifact,0,id' build.log | tail -1 | cut -d, -f6 | cut -d: -f2)
          echo "ami_id=$AMI_ID" >> "$GITHUB_OUTPUT"

      - name: Publish AMI id to SSM
        run: |
          aws ssm put-parameter \
            --name "/ctech/${{ inputs.environment }}/ami/alpine/arm64" \
            --value "${{ steps.build.outputs.ami_id }}" \
            --type String --overwrite
```

- [ ] **Step 4: Write the failing test for the Packer IAM role**

Add to `test/global-stack.test.ts` (create it if Step 1 found none — mirror
the synth style already used in `test/dragonfly.test.ts`):

```typescript
import assert from 'node:assert/strict';
import {test} from 'node:test';
import * as cdk from 'aws-cdk-lib';
import {Match, Template} from 'aws-cdk-lib/assertions';
import {GlobalStack} from '../lib/global-stack';

function synth() {
  const app = new cdk.App();
  const stack = new GlobalStack(app, 'Ctech-Global', {
    env: {account: '868899309401', region: 'us-east-1'},
    certArn: 'arn:aws:acm:us-east-1:868899309401:certificate/fixture',
    ctechGithubRepo: 'artur-oliveira/ctech-cdk',
  });
  return Template.fromStack(stack);
}

test('the Packer build role is scoped to image-build actions, never AdministratorAccess', () => {
  const template = synth();
  template.hasResourceProperties('AWS::IAM::Role', {
    RoleName: 'ctech-gha-packer',
  });
  template.hasResourceProperties('AWS::IAM::Policy', {
    PolicyDocument: Match.objectLike({
      Statement: Match.arrayWith([Match.objectLike({
        Action: Match.arrayWith(['ec2:CreateImage', 'ec2:RegisterImage']),
      })]),
    }),
  });
});
```

- [ ] **Step 5: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — no `AWS::IAM::Role` with `RoleName: 'ctech-gha-packer'`

- [ ] **Step 6: Add the role to `lib/global-stack.ts`**

Insert after the existing `infraRole` block, reusing the same inline
`FederatedPrincipal` `trust` this file already constructs:

```typescript
    // ctech-gha-packer: builds the Alpine AMI. Deliberately separate from
    // infraRole (AdministratorAccess) — Packer needs broad EC2 build/image
    // actions, not the ability to touch every other AWS service.
    const packerRole = new iam.Role(this, 'PackerBuildRole', {
      roleName: 'ctech-gha-packer',
      assumedBy: trust,
    });
    packerRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'ec2:RunInstances',
        'ec2:TerminateInstances',
        'ec2:CreateImage',
        'ec2:RegisterImage',
        'ec2:DeregisterImage',
        'ec2:DescribeImages',
        'ec2:DescribeInstances',
        'ec2:DescribeInstanceStatus',
        'ec2:DescribeSnapshots',
        'ec2:DescribeSubnets',
        'ec2:DescribeSecurityGroups',
        'ec2:DescribeVolumes',
        'ec2:CreateTags',
        'ec2:CreateKeyPair',
        'ec2:DeleteKeyPair',
        'ec2:CreateSecurityGroup',
        'ec2:DeleteSecurityGroup',
        'ec2:AuthorizeSecurityGroupIngress',
        'ec2:GetPasswordData',
      ],
      // Packer's amazon-ebs builder does not support resource-level scoping
      // for most of these actions — they are EC2 control-plane calls against
      // whatever build instance/AMI/snapshot IDs Packer creates that run.
      resources: ['*'],
    }));
    packerRole.addToPolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameter', 'ssm:PutParameter'],
      resources: ['arn:aws:ssm:*:*:parameter/ctech/*'],
    }));
    packerRole.addToPolicy(new iam.PolicyStatement({
      actions: ['s3:GetObject'],
      resources: ['arn:aws:s3:::*-ctech-ec2-scripts/*'],
    }));

    new cdk.CfnOutput(this, 'PackerRoleArn', {value: packerRole.roleArn});
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npm test`
Expected: PASS

- [ ] **Step 8: Type-check and synth**

Run: `npx tsc --noEmit`
Run: `ENVIRONMENT=dev npx cdk synth Ctech-Global --no-bundling`
Expected: no errors; inspect the synthesized `AWS::IAM::Role`/`AWS::IAM::Policy`
for `ctech-gha-packer` — confirm no `AdministratorAccess` reference anywhere
near it.

- [ ] **Step 9: Commit**

```bash
git add packer .github/workflows/build-alpine-ami.yml lib/global-stack.ts test/global-stack.test.ts
git commit -m "feat: add the Packer Alpine AMI pipeline and its dedicated IAM role"
```

---

## Task 12: `ValkeyStackV2`

**Files:**
- Create: `lib/valkey-stack-v2.ts`
- Modify: `bin/ctech-cdk.ts` (commented-out wiring, staged like `DragonflyStack`)
- Test: `test/valkey-v2.test.ts`

**Interfaces:**
- Consumes: `SSM.amiAlpine`, `SSM.ec2ScriptsAlpine`, `SSM.ctechEc2Agent` (Task
  2); `addAsgSchedule`, `AsgScheduleProps` (existing, from
  `lib/haproxy-ec2-service.ts` — reused, not redefined).
- Produces: `ValkeyStackV2`, same public `urlSsmPath` contract as `ValkeyStack`.

- [ ] **Step 1: Write the failing test**

`test/valkey-v2.test.ts` (mirrors `test/dragonfly.test.ts`'s synth-based style):

```typescript
import assert from 'node:assert/strict';
import {test} from 'node:test';
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import {Match, Template} from 'aws-cdk-lib/assertions';
import {ValkeyStackV2} from '../lib/valkey-stack-v2';

function synth() {
  const app = new cdk.App({context: {'aws:cdk:bundling-stacks': []}});
  const base = new cdk.Stack(app, 'Base', {env: {account: '111111111111', region: 'us-east-1'}});
  const vpc = new ec2.Vpc(base, 'Vpc', {maxAzs: 2});
  const stack = new ValkeyStackV2(app, 'Ctech-Prod-ValkeyV2', {
    env: {account: '111111111111', region: 'us-east-1'},
    environment: 'prod',
    vpc,
  });
  return {template: Template.fromStack(stack), stack};
}

test('keeps the same SSM URL contract as ValkeyStack, so no service repository changes', () => {
  const {template} = synth();
  template.hasResourceProperties('AWS::SSM::Parameter', {
    Name: '/ctech/prod/valkey/url',
  });
});

test('boots from the Alpine AMI via an SSM parameter, not a hardcoded AMI id', () => {
  const {template} = synth();
  const templates = template.findResources('AWS::EC2::LaunchTemplate');
  const data = JSON.stringify(Object.values(templates)[0].Properties.LaunchTemplateData);
  assert.match(data, /ami-alpine-arm64|ResolveAMI|AWS::SSM::Parameter::Value/, 'AMI id must resolve via SSM, not a literal ami- string');
});

test('targets a 1 GiB root volume', () => {
  const {template} = synth();
  template.hasResourceProperties('AWS::EC2::LaunchTemplate', {
    LaunchTemplateData: Match.objectLike({
      BlockDeviceMappings: [Match.objectLike({Ebs: Match.objectLike({VolumeSize: 1, Encrypted: true})})],
    }),
  });
});

test('user data calls ctech-ec2-agent, never the AWS CLI', () => {
  const {template} = synth();
  const templates = template.findResources('AWS::EC2::LaunchTemplate');
  const userData = JSON.stringify(Object.values(templates)[0].Properties.LaunchTemplateData.UserData);
  assert.match(userData, /ctech-ec2-agent/);
  assert.doesNotMatch(userData, /\baws ssm\b|\baws s3\b|\baws route53\b/);
});

test('keeps one instance in prod, matching ValkeyStack today', () => {
  const {template} = synth();
  template.hasResourceProperties('AWS::AutoScaling::AutoScalingGroup', {
    MinSize: '1',
    MaxSize: '1',
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module '../lib/valkey-stack-v2'`

- [ ] **Step 3: Write `lib/valkey-stack-v2.ts`**

```typescript
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import {Construct} from 'constructs';
import {Environment} from './types';
import {SSM} from './constants';
import {addAsgSchedule, AsgScheduleProps} from './haproxy-ec2-service';

interface ValkeyStackV2Props extends cdk.StackProps {
  environment: Environment;
  vpc: ec2.Vpc;
  privateHostedZone?: route53.IPrivateHostedZone;
  schedule?: AsgScheduleProps;
}

/**
 * Alpine/OpenRC equivalent of ValkeyStack (lib/valkey-stack.ts), same
 * external contract: /ctech/{env}/valkey/url and cache.internal.aoctech.app.
 * The two cannot coexist — cut over the same way ValkeyStack/DragonflyStack
 * already do: delete the old stack, then deploy this one.
 */
export class ValkeyStackV2 extends cdk.Stack {
  public readonly urlSsmPath: string;

  constructor(scope: Construct, id: string, props: ValkeyStackV2Props) {
    super(scope, id, props);

    const {environment, vpc, privateHostedZone} = props;
    const isProd = environment === 'prod';
    const dnsName = privateHostedZone ? `cache.${privateHostedZone.zoneName}` : undefined;

    this.urlSsmPath = SSM.valkey(environment).url;

    const sg = new ec2.SecurityGroup(this, 'ValkeySg', {
      vpc,
      securityGroupName: `${environment}-ctech-valkey-v2-sg`,
      description: 'Shared Valkey (Alpine) - reachable from VPC only on port 6379',
      allowAllOutbound: true,
      allowAllIpv6Outbound: true,
    });
    sg.addIngressRule(ec2.Peer.ipv4(vpc.vpcCidrBlock), ec2.Port.tcp(6379), 'Valkey: VPC IPv4');

    const role = new iam.Role(this, 'ValkeyRole', {
      roleName: `${environment}-ctech-valkey-v2-role`,
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
      ],
    });
    role.addToPolicy(new iam.PolicyStatement({
      actions: ['ssm:PutParameter'],
      resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter${this.urlSsmPath}`],
    }));
    role.addToPolicy(new iam.PolicyStatement({
      actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
      resources: [`arn:aws:logs:${this.region}:${this.account}:log-group:/ctech/${environment}/valkey:*`],
    }));
    if (privateHostedZone) {
      role.addToPolicy(new iam.PolicyStatement({
        actions: ['route53:ChangeResourceRecordSets'],
        resources: [`arn:${this.partition}:route53:::hostedzone/${privateHostedZone.hostedZoneId}`],
      }));
    }

    const instanceProfile = new iam.InstanceProfile(this, 'ValkeyInstanceProfile', {
      instanceProfileName: `${environment}-ctech-valkey-v2-profile`,
      role,
    });

    const logGroup = new logs.LogGroup(this, 'ValkeyLogGroup', {
      logGroupName: `/ctech/${environment}/valkey`,
      retention: isProd ? logs.RetentionDays.ONE_MONTH : logs.RetentionDays.ONE_WEEK,
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    const scriptsBucket = ssm.StringParameter.valueForStringParameter(this, SSM.ec2ScriptsAlpine(environment).bucket);
    const scriptsVersion = ssm.StringParameter.valueForStringParameter(this, SSM.ec2ScriptsAlpine(environment).version);
    const agentBucket = ssm.StringParameter.valueForStringParameter(this, SSM.ctechEc2Agent(environment).bucket);
    const agentVersion = ssm.StringParameter.valueForStringParameter(this, SSM.ctechEc2Agent(environment).version);

    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      'set -euo pipefail',
      `CTECH_SCRIPTS="s3://${scriptsBucket}/${scriptsVersion}"`,
      `CTECH_AGENT="s3://${agentBucket}/${agentVersion}/ctech-ec2-agent"`,
      'ctech_run(){ s=$1; shift; curl -sf "https://${CTECH_SCRIPTS#s3://}.s3.amazonaws.com/$s" -o "/tmp/$s" || aws s3 cp "$CTECH_SCRIPTS/$s" "/tmp/$s"; bash "/tmp/$s" "$@"; }',
      'mkdir -p /usr/local/bin',
      // The agent itself is what setup-ssm-env.sh/setup-realip.sh/etc. call —
      // it must land before any script that calls `ctech-ec2-agent` runs.
      `aws s3 cp "$CTECH_AGENT" /usr/local/bin/ctech-ec2-agent`,
      'chmod +x /usr/local/bin/ctech-ec2-agent',

      'ctech_run setup-base.sh valkey valkey valkey-openrc',
      'ctech_run setup-dualstack.sh',

      `cat > /etc/valkey/valkey.conf << 'VALKEYCONF'`,
      'bind 0.0.0.0 ::',
      'protected-mode no',
      'port 6379',
      'daemonize no',
      'loglevel notice',
      'databases 16',
      'save ""',
      'appendonly no',
      'maxmemory 128mb',
      'maxmemory-policy allkeys-lfu',
      'tcp-keepalive 60',
      'timeout 0',
      'logfile /var/log/valkey/valkey.log',
      'VALKEYCONF',
      'rc-update add valkey default',
      'rc-service valkey start',

      `cat > /tmp/ctech-logs.json << 'LOGSCFG'`,
      JSON.stringify({
        logGroup: logGroup.logGroupName,
        files: [{path: '/var/log/valkey/valkey.log', streamPrefix: 'valkey'}],
      }),
      'LOGSCFG',
      'ctech_run setup-ctech-ec2-agent.sh /tmp/ctech-logs.json',

      `cat > /opt/register-valkey.sh << 'REG'`,
      '#!/bin/bash',
      'export AWS_USE_DUALSTACK_ENDPOINT=true',
      `SSM_PATH="${this.urlSsmPath}"`,
      `DNS_NAME="${dnsName ?? ''}"`,
      'TOKEN=$(curl -sf -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 60")',
      'LOCAL_IP=$(curl -sf -H "X-aws-ec2-metadata-token: $TOKEN" "http://169.254.169.254/latest/meta-data/local-ipv4")',
      ...(privateHostedZone ? [
        `HOSTED_ZONE_ID="${privateHostedZone.hostedZoneId}"`,
        `ctech-ec2-agent route53-upsert -zone-id "$HOSTED_ZONE_ID" -name "${dnsName}" -value "$LOCAL_IP"`,
      ] : []),
      'ENDPOINT_HOST="${DNS_NAME:-$LOCAL_IP}"',
      'ctech-ec2-agent ssm-put -name "$SSM_PATH" -value "redis://${ENDPOINT_HOST}:6379"',
      'echo "Registered Valkey base URL: redis://${ENDPOINT_HOST}:6379"',
      'REG',
      'chmod +x /opt/register-valkey.sh',
      'bash /opt/register-valkey.sh',
      'echo "$(( RANDOM % 60 )) * * * * root /opt/register-valkey.sh" > /etc/crontabs/root',
    );

    const machineImage = ec2.MachineImage.fromSsmParameter(
      SSM.amiAlpine(environment).arm64,
      {os: ec2.OperatingSystemType.LINUX},
    );

    const launchTemplate = new ec2.LaunchTemplate(this, 'ValkeyLaunchTemplate', {
      launchTemplateName: `${environment}-ctech-valkey-v2-lt`,
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.NANO),
      machineImage,
      blockDevices: [{
        deviceName: '/dev/xvda',
        volume: ec2.BlockDeviceVolume.ebs(1, {
          volumeType: ec2.EbsDeviceVolumeType.GP3,
          deleteOnTermination: true,
          encrypted: true,
        }),
      }],
      userData,
      instanceProfile,
      requireImdsv2: true,
      securityGroup: sg,
    });

    const cfnLT = launchTemplate.node.defaultChild as ec2.CfnLaunchTemplate;
    cfnLT.addPropertyDeletionOverride('LaunchTemplateData.SecurityGroupIds');
    cfnLT.addPropertyOverride('LaunchTemplateData.NetworkInterfaces', [{
      DeviceIndex: 0,
      Groups: [sg.securityGroupId],
      AssociatePublicIpAddress: false,
      Ipv6AddressCount: 1,
    }]);
    cfnLT.addPropertyOverride(
      'LaunchTemplateData.TagSpecifications',
      [{ResourceType: 'instance', Tags: [{Key: 'Name', Value: `${environment}-ctech-valkey-v2`}]}],
    );

    const asg = new autoscaling.AutoScalingGroup(this, 'ValkeyASG', {
      autoScalingGroupName: `${environment}-ctech-valkey-v2`,
      vpc,
      vpcSubnets: {subnetType: ec2.SubnetType.PUBLIC},
      mixedInstancesPolicy: {
        launchTemplate,
        instancesDistribution: {
          onDemandPercentageAboveBaseCapacity: 0,
          spotAllocationStrategy: autoscaling.SpotAllocationStrategy.PRICE_CAPACITY_OPTIMIZED,
        },
      },
      capacityRebalance: true,
      minCapacity: isProd ? 1 : 0,
      maxCapacity: 1,
      cooldown: cdk.Duration.minutes(5),
    });

    if (props.schedule) {
      addAsgSchedule(asg, {minCapacity: isProd ? 1 : 0, maxCapacity: 1}, props.schedule);
    }

    new ssm.StringParameter(this, 'ValkeyUrlPlaceholder', {
      parameterName: this.urlSsmPath,
      stringValue: 'pending-first-boot',
      description: `Shared Valkey base URL (Alpine) - overwritten by EC2 instance at boot (${environment})`,
    });

    new cdk.CfnOutput(this, 'ValkeyUrlSsmPath', {value: this.urlSsmPath, exportName: `${id}-url-ssm-path`});
    new cdk.CfnOutput(this, 'ValkeyAsgName', {value: asg.autoScalingGroupName, exportName: `${id}-asg-name`});
    if (dnsName) {
      new cdk.CfnOutput(this, 'ValkeyDnsName', {value: dnsName, exportName: `${id}-dns-name`});
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: Type-check and synth**

Run: `npx tsc --noEmit`
Run: `ENVIRONMENT=prod npx cdk synth Ctech-Prod-ValkeyV2 --no-bundling` (once
wired into `bin/ctech-cdk.ts` in Step 6 — synth may need a temporary local
edit if the stack isn't wired yet; verify via the test suite's own synth path
if `cdk synth` isn't yet reachable)
Expected: no errors. Inspect the IAM policy diff: confirm `ValkeyRole` has no
broader permissions than the equivalent block in `lib/valkey-stack.ts` minus
`CloudWatchAgentServerPolicy` (removed — no CloudWatch Agent on this path)
plus the new scoped `logs:PutLogEvents`/`logs:CreateLogStream` statement.

- [ ] **Step 6: Stage the wiring in `bin/ctech-cdk.ts`**

Add, commented out, right after the existing commented-out `DragonflyStack`
block and before the active `new ValkeyStack(...)` call — matching how
Dragonfly is already staged there:

```typescript
// =====================
// ValkeyStackV2 (Alpine) — staged for the prod cutover in
// docs/plans/2026-08-23-alpine-ec2-ami.md Task 13. Do not uncomment until
// that task's pre-cutover validation has passed.
//
// import {ValkeyStackV2} from '../lib/valkey-stack-v2';
// new ValkeyStackV2(app, `Ctech-${cap(ENVIRONMENT)}-ValkeyV2`, {
//   env,
//   environment: ENVIRONMENT,
//   vpc: networkStack.vpc,
//   privateHostedZone: networkStack.privateHostedZone,
//   description: `CTech Shared Valkey Cache (Alpine) - ${ENVIRONMENT}`,
// });
// =====================
```

- [ ] **Step 7: Commit**

```bash
git add lib/valkey-stack-v2.ts bin/ctech-cdk.ts test/valkey-v2.test.ts
git commit -m "feat: add ValkeyStackV2 (Alpine), staged but not wired in"
```

---

## Task 13: Pre-cutover validation and the prod cutover itself

Everything up to here is code, tested and synth-clean, but not live. This
task is operational, not autonomous: **each step that touches real AWS
resources or deletes a live stack needs your explicit go-ahead in the
moment** — don't run Steps 3, 5, or 6 unattended.

**Files:** none (operational task — no code changes).

- [ ] **Step 1: Run the Packer build workflow**

Trigger `.github/workflows/build-alpine-ami.yml` (`workflow_dispatch`,
`environment: prod`, since spec §7 goes straight to prod). Confirm
`/ctech/prod/ami/alpine/arm64` is populated in SSM afterward.

- [ ] **Step 2: Boot the AMI standalone and measure it (spec §2, §8 step 2-3)**

Launch one `t4g.nano` instance directly from the built AMI (not via CDK — a
plain `aws ec2 run-instances`), IMDSv2 required. On it:

```bash
rc-status                                   # amazon-ssm-agent must show 'started'
df -h /                                     # confirms real root usage
free -m                                     # confirms real memory/swap headroom
/usr/local/bin/ctech-ec2-agent ssm-get -name /ctech/prod/valkey/url  # sanity call
```

Record the real `df -h /` number. If it leaves comfortable headroom under 1
GiB, keep `rootVolumeGiB: 1` in `lib/valkey-stack-v2.ts` as-is. If it doesn't,
bump the `ec2.BlockDeviceVolume.ebs(1, ...)` call in Task 12 Step 3 to the
smallest size that does, and re-run that task's tests/synth. Terminate the
throwaway instance when done.

- [ ] **Step 3: Confirm Session Manager reaches the throwaway instance**

`aws ssm start-session --target <instance-id>` — must connect. This is the
one hard requirement from the spec's Goal that nothing in Tasks 1–12
automatically verifies.

- [ ] **Step 4: Uncomment the `ValkeyStackV2` wiring**

Undo Task 12 Step 6's comment in `bin/ctech-cdk.ts`. Run `npm test`,
`npx tsc --noEmit`, and `ENVIRONMENT=prod npx cdk diff Ctech-Prod-ValkeyV2` to
see exactly what will be created. Commit this uncomment on its own:

```bash
git add bin/ctech-cdk.ts
git commit -m "feat: wire ValkeyStackV2 into bin/ctech-cdk.ts for the prod cutover"
```

- [ ] **Step 5: Cut prod's Valkey over**

Per spec §7 — prod-direct, no dev staging, an accepted brief empty-cache
window (same pattern already documented for the Dragonfly↔Valkey switch):

```bash
ENVIRONMENT=prod npx cdk deploy Ctech-Prod-ValkeyV2 --require-approval never
aws cloudformation delete-stack --stack-name Ctech-Prod-ValKey
```

Watch `/ctech/prod/valkey/url` update and confirm dependent services
reconnect. **Confirm with the user before running the `delete-stack` call** —
it is exactly the kind of hard-to-reverse, shared-infrastructure action this
plan should not execute without a human directly in the loop at that moment.

- [ ] **Step 6: Soak 1 day, then report**

Per spec §7. After 1 day with no alarms/errors on the new Valkey instance,
report back: this plan's `ctech-cdk` scope is done.

- [ ] **Step 7: Hand off the cross-repo piece**

The `ctech-billing` pilot (nginx + app + `send-command` deploy against the
Alpine AMI, spec §7) is **out of scope for this plan** — it requires editing
`ctech-billing`'s own Terraform (`bootstrap.sh.tftpl`) to call
`assets/ec2-alpine/*.sh` instead of `assets/ec2/*.sh`, reading
`/ctech/prod/ami/alpine/arm64` / `/ctech/prod/ec2-scripts-alpine/*` /
`/ctech/prod/ctech-ec2-agent/*` from this repo's SSM output. Everything those
Terraform changes need is now published by this plan's Tasks 8–11. Flag this
explicitly to whoever picks up `ctech-billing` next — do not attempt it from
inside this repo.

---

## Self-Review Notes

- **Spec coverage:** §1 (Packer/pipeline) → Task 11. §2 (disk budget) → Task
  12 Step 3 + Task 13 Step 2. §3 (package inventory) → Task 8 Step 3, Task 11
  Step 2. §4 (`ctech-ec2-agent` subcommands) → Tasks 3–6. §5 (OpenRC mapping)
  → Task 8. §6 (file layout/CDK/publishing) → Tasks 2, 7, 9, 10, 12. §7
  (rollout) → Task 13. §8 (testing) → Task 13 Steps 1–3 plus each task's own
  test step. Documentation section → Task 1 (drift fix) and Task 11/12's
  synth-inspection steps (IAM/SG review is folded into each task rather than a
  separate step, per this repo's `CLAUDE.md` mandatory workflow item 6).
- **Placeholder scan:** none found — every step above has literal code, exact
  file paths, or an exact shell command.
- **Type consistency:** `ValkeyStackV2` uses `SSM.amiAlpine`, `SSM.ec2ScriptsAlpine`,
  `SSM.ctechEc2Agent` exactly as defined in Task 2; `Ec2ScriptsStack.alpineScriptsVersion`/`agentVersion`
  (Task 9) are the same names Task 12 doesn't need to touch (it reads the SSM
  parameters, not the stack's TS fields, since it's a separate stack).
  `ctech-ec2-agent`'s subcommand names (`ssm-get`, `ssm-put`, `prefix-list`,
  `route53-upsert`, `s3-cp`, `s3-head`, `logs-tail`) are used identically across
  Tasks 3–6 (Go `main.go` dispatch), Task 8 (shell scripts), and Task 12
  (`ValkeyStackV2` user data) — checked against each other.
