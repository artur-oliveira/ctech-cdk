#!/usr/bin/env bash
# Ctech family standards gate. Canonical copy: ctech-skills/scripts/standards-check.sh.
# Run from a repo root. Exempt one line with a trailing `standards:allow <reason>`.
# Env: FAMILY_GOCOMMON_MINOR (default v1.39).
set -uo pipefail
FAMILY="${FAMILY_GOCOMMON_MINOR:-v1.39}"
fail=0
# STANDARDS_SKIP="apierror,Scan": known debt, comma list of words matched in a rule message; reported as warnings.
bad() {
  local s="${STANDARDS_SKIP:-}" w; for w in ${s//,/ }; do
    [[ "$1" == *"$w"* ]] && { echo "::warning::standards (baselined): $1"; return; }
  done
  echo "::error::standards: $1"; fail=1
}

# grep_rule <message> <ERE> <path...>: fail on matches outside tests/vendor/node_modules, unless allowed.
grep_rule() {
  local msg="$1" re="$2"; shift 2
  local paths=(); for p in "$@"; do [ -e "$p" ] && paths+=("$p"); done
  [ ${#paths[@]} -eq 0 ] && return
  local out
  out=$(grep -rnE --include='*.go' --include='*.ts' --include='*.tsx' --include='*.tf' --include='*.yml' \
    --exclude='*_test.go' --exclude='*.test.ts' --exclude='*.test.tsx' --exclude='*.d.ts' \
    --exclude-dir=.claude --exclude-dir=node_modules --exclude-dir=vendor --exclude-dir=cdk.out --exclude-dir=.next --exclude-dir=.terraform \
    -e "$re" "${paths[@]}" 2>/dev/null | grep -v 'standards:allow')
  [ -n "$out" ] && { echo "$out" | head -20; bad "$msg"; }
}

# Go services
for d in $(find . -name go.mod -not -path '*/node_modules/*' -exec dirname {} \;); do
  [ -d "$d/internal/apierror" ] && bad "$d: local apierror package; use go-common problem"
  # a local problem package is fine only as a registry on top of go-common problem
  [ -d "$d/internal/problem" ] && ! grep -rq 'api-commons/problem' "$d/internal/problem" && bad "$d: local problem package that does not build on go-common problem"
  v=$(grep -E 'gopkg.aoctech.app/api-commons ' "$d/go.mod" | awk '{print $2}')
  [ -n "$v" ] && [[ "$v" != $FAMILY.* ]] && bad "$d: go-common $v, family minor is $FAMILY"
  grep_rule "log.Print*/Fatal* in $d; use slog" '\blog\.(Printf|Println|Print|Fatalf|Fatal|Panicf)\(' $(find "$d" -type d -name internal -not -path '*/node_modules/*')
  grep_rule "dynamodb Scan in $d; use a GSI (operator tools live under cmd/ and are exempt)" '\.Scan\(ctx|dynamodb\.ScanInput|ScanPaginator' \
    $(find "$d" -type d \( -path '*/internal/*' \) -maxdepth 3 2>/dev/null | grep -v '/cmd/')
done

# Worker code (worker/ and lambda*/ dirs) must not mint a root context: it arrives from internal/boot (cmd/, main.go, boot are exempt).
wd=$(find . -type d \( -name worker -o -name 'lambda*' \) -not -path '*/node_modules/*' -not -path '*/cmd/*' -not -path '*/ui/*' 2>/dev/null)
[ -n "$wd" ] && {
  out=$(grep -rnE 'context\.(Background|TODO)\(\)' $wd --include='*.go' --exclude='*_test.go' --exclude=main.go --exclude-dir=cmd --exclude-dir=boot --exclude-dir=vendor 2>/dev/null | grep -v 'standards:allow')
  [ -n "$out" ] && { echo "$out" | head -20; bad "ctxbg: context.Background/TODO in worker code; take the context from internal/boot"; }
}

# UI apps: no local copy of an @aoctech/ui export (a file named like one; wrappers/exceptions carry a `standards:allow <reason>` comment in the file).
# ponytail: static name list = ctech-ui src/index.ts components; refresh it when ctech-ui exports a new component.
UI_NAMES="Badge Button Alert Calendar DatePicker Checkbox EmptyState Field Input Modal Drawer PageHeader Separator Skeleton Radio RadioGroup Switch ThemeProvider ErrorState BottomNav UserMenu AppShell SidebarNav RowMenu Segmented Select Textarea Label SwipeRow Steps FileDrop CommandPalette NetworkProvider OfflineBanner UnavailableScreen"
for u in $(find . -maxdepth 3 -name package.json -not -path '*/node_modules/*' -exec grep -l '"@aoctech/ui"' {} + 2>/dev/null | xargs -r -n1 dirname); do
  for f in $(find "$u/src" -type f \( -name '*.ts' -o -name '*.tsx' \) -not -name '*.test.*' -not -name '*.stories.*' -not -name '*.d.ts' 2>/dev/null \
      | awk -v n="$UI_NAMES" 'BEGIN{split(n,a," ");for(i in a)s[tolower(a[i])]=1}{b=$0;sub(/.*\//,"",b);sub(/\.tsx?$/,"",b);gsub(/[-_]/,"",b);if(tolower(b) in s)print}'); do
    grep -q 'standards:allow' "$f" && continue
    echo "$f"; bad "uidup: $f duplicates an @aoctech/ui export; import it (wrap with a standards:allow <reason> comment if intentional)"
  done
done

# Infra: no hand-rolled metrics/alarms/NAT/ALB (ctech-cdk owns ALB stack)
grep_rule "custom metrics/alarms are banned; alert through go-common alerts" 'PutMetricData|MetricFilter|CloudWatch::Alarm|cloudwatch\.Alarm\(' . 
case "$(basename "$PWD")" in ctech-cdk) ;; *)
  grep_rule "NAT gateway / ALB construct banned (cost rules)" 'NatGateway|natGateways|ApplicationLoadBalancer\(|aws_lb\b|aws_nat_gateway' cdk terraform infra ;;
esac

# CI: checks must not be softened
if [ -d .github/workflows ]; then
  out=$(grep -rn '|| true' .github/workflows | grep -v 'standards:allow')
  [ -n "$out" ] && { echo "$out"; bad "'|| true' on a CI step hides failures"; }
fi

# Locale key parity
for d in $(find . -type d -name locales -not -path '*/node_modules/*'); do
  [ -f "$d/pt-BR.json" ] && [ -f "$d/en.json" ] || continue
  diff <(jq -r '[paths(scalars)|join(".")]|sort[]' "$d/pt-BR.json") <(jq -r '[paths(scalars)|join(".")]|sort[]' "$d/en.json") >/dev/null \
    || bad "$d: pt-BR and en keys differ"
done

[ $fail -eq 0 ] && echo "standards: ok"
exit $fail
