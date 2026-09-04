# Alpine chronyd never syncs — production clock drift

## Incident

`ctech-poker`'s production API instance (`i-07a59f22471db70c5`, Alpine/OpenRC,
`prod-ctech-poker` ASG) was found ~23 seconds behind real time on 2026-09-04,
worsening continuously. Confirmed via SSM: `chronyc tracking` reported
`Leap status : Not synchronised` and every configured source at `Reach 0`.
Independently confirmed by diffing `date -u +%s.%N` on the instance against an
accurate reference clock.

This is a shared-image defect, not poker-specific: every service booting
through `assets/ec2-alpine/setup-base.sh` (currently `ctech-poker`'s API ASG
and `ValkeyStackV2`, staged) inherits it.

### Why it silently got worse over time

`/etc/chrony.conf` (Alpine's official cloud image default, untouched by this
repo's scripts before this fix) configures only `pool pool.ntp.org`. This
VPC has no NAT Gateway and no internet egress for arbitrary hosts (see the
root `CLAUDE.md`'s "Public services have no public IPv4 and the VPC has no
NAT Gateway"), so every source sits at `Reach 0` forever — chronyd never
disciplines the clock at all. The instance's own crystal oscillator drift
(measured live at 287.231 ppm fast) then accumulates unchecked for as long as
the instance runs. A freshly-launched instance is only off by a second or two;
one that has survived ~16 hours (this repo's Spot instances get replaced
often — see `ec89cef`, which diversified Spot instance types) accumulates
tens of seconds of error.

### Downstream effect on ctech-poker

`ctech-poker`'s turn timer and next-hand countdown are absolute Unix-ms
deadlines (`action_base_deadline_unix_ms`, `action_deadline_unix_ms`,
`next_hand_unix_ms`), computed server-side as `time.Now().Add(duration)` and
sent to clients as-is — not a duration relative to receipt. When the
server's own `time.Now()` already reads ~23s ahead of real time, every
deadline it computes is silently front-loaded by that same amount: a client
receives a "deadline" already in the past relative to real-world wall clock
time, even though delivery itself was fast (confirmed via HAR captures:
~220ms action-to-broadcast latency). `ui/src/components/table/Seat.tsx`'s
`showNormalClock`/`showTimeBank` and
`ui/src/lib/hooks/useTableOutcome.ts`'s duration derivation are both correct
given the timestamps they're handed — they have no way to know the sender's
clock is wrong. This was misdiagnosed earlier the same day as Valkey Pub/Sub
delivery latency (`ctech-poker` commits `e40f7b8`/`19d0c71`): the ~16-17s gap
measured between a server log line's own `time.Now()` and a client's receipt
timestamp was itself contaminated by the same bad server clock, not a real
transport delay. The dedicated realtime Valkey client from that work is a
reasonable isolation improvement on its own merits but did not fix this
incident.

## Fix

`assets/ec2-alpine/setup-base.sh` now overwrites `/etc/chrony.conf` to use
the Amazon Time Sync Service instead:

```
server 169.254.169.123 prefer iburst minpoll 4 maxpoll 4
driftfile /var/lib/chrony/chrony.drift
rtcsync
cmdport 0
```

`169.254.169.123` is a link-local address served directly by the EC2
hypervisor on every instance, regardless of VPC networking, NAT, security
groups or NACLs — see AWS's Time Sync Service documentation. Any stale
`chrony.drift` from a prior boot under the broken config is deleted before
chronyd restarts, so a fresh sync is never blended with a frequency estimate
computed while never actually synchronized. `chronyc waitsync` is called with
a bounded 30s timeout and does not fail the boot on timeout — an unreachable
Time Sync Service should not brick every instance launch, but is worth a
loud warning in the boot log.

This applies to every consumer of `setup-base.sh` on next instance
replacement, with no AMI rebuild required — the script is fetched fresh from
S3 (`Ec2ScriptsStack`, content-hash keyed) by the `ctech-userdata` OpenRC
service at boot.

## Remediation on the current instance

Correcting a ~23s-behind clock steps it forward. Every already-persisted
absolute deadline for tables this instance is currently serving would
retroactively become "already elapsed" the instant the step happens,
triggering a burst of auto-fold/kick timeouts across every active hand.
The instance must be drained (removed from rotation, its tables allowed to
finish or move to a re-launched replacement) before applying the corrected
chrony config and restarting chronyd — never step the clock live under
active tables.

## Not done here

- The Packer-built custom Alpine AMI (`packer/alpine-arm64.pkr.hcl`) is not
  yet the source image for any deployed stack (see root `CLAUDE.md`, "Alpine
  AMI pipeline (staged)") — `setup-base.sh` alone is sufficient since it runs
  on every boot regardless of which Alpine base image is used. If the Packer
  AMI pipeline becomes the source of truth later, consider baking the chrony
  config in at build time too, purely as defense in depth (userdata already
  covers every current and staged consumer).
- No CloudWatch alarm on chrony sync state yet. The user's own suggestion —
  "adicionar monitoramento de sincronização e offset" — is real follow-up
  work, not done in this change.
- `api/internal/table/turntimeout.go` currently defines 15s normal turn / 12s
  next-hand, not 12s/12s. If the intended product rule is actually 12s for
  the normal turn too, that is a separate, unrelated discrepancy — not an
  effect of this incident and not changed here.
