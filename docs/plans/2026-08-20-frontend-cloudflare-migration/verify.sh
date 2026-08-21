#!/usr/bin/env bash
# Static gates: Phase 0 on a spike, Phase 3 on each service's prod Worker.
# Usage: ./verify.sh <base-url> [expected-connect-src-origin ...]
#
# ROUTES overrides the paths probed for pretty URLs, which are per service —
# the defaults below are dfe's. `/` is always included. The second path is also
# the one the trailing-slash check uses, so name a real nested route:
#   ROUTES='/ /login /gambling/activate' ./verify.sh https://…workers.dev …
#
# Every gate here is answerable by the edge alone. The login round trip, the
# preflight and the WebSocket need the real origin in CORS_ALLOWED_ORIGINS and a
# running API, so they are not in this script — see Phase 3 in the plan.
set -uo pipefail
BASE="${1:?usage: verify.sh <base-url> [expected-connect-src-origin ...]}"
shift
EXPECTED_ORIGINS=("$@")
read -ra ROUTE_LIST <<<"${ROUTES:-/ /dashboard /guide/nfe /nfe/emit}"
NESTED="${ROUTE_LIST[1]:-/}"
fail=0
ok()   { printf '  PASS  %s\n' "$1"; }
bad()  { printf '  FAIL  %s\n' "$1"; fail=1; }

code() { curl -sS -o /dev/null -w '%{http_code}' "$1"; }
hdr()  { curl -sSD - -o /dev/null "$1" | tr -d '\r' | grep -i "^$2:" | cut -d' ' -f2-; }

echo "== pretty URLs (no route manifest)"
# Real routes from `find out -name '*.html'`. Next exports dashboard.html, not
# dashboard/index.html, so html_handling=auto-trailing-slash serves them bare.
for p in "${ROUTE_LIST[@]}"; do
  c=$(code "$BASE$p")
  [ "$c" = 200 ] && ok "$p -> 200" || bad "$p -> $c (expected 200)"
done
# A trailing slash on a bare .html asset is expected to 308 to the bare form.
raw=$(code "$BASE$NESTED/")
final=$(curl -sSL -o /dev/null -w '%{http_code}' "$BASE$NESTED/")
# Cloudflare normalises the trailing slash with a 307, not a 308 or 301.
case "$raw" in
  200|30[1278]) ok "$NESTED/ -> $raw, follows to $final";;
  *) bad "$NESTED/ -> $raw (expected 200 or a 3xx)";;
esac
[ "$final" = 200 ] || bad "$NESTED/ ends at $final after redirects"

echo "== 404 must be a real 404, not a 200"
c=$(code "$BASE/definitely-not-a-route-$$")
[ "$c" = 404 ] && ok "unknown path -> 404" || bad "unknown path -> $c (expected 404)"
body=$(curl -sS "$BASE/definitely-not-a-route-$$" | wc -c)
[ "$body" -gt 500 ] && ok "404 body is the export's 404.html ($body bytes)" \
  || bad "404 body only $body bytes — not_found_handling likely not applied"

echo "== _headers reproduces the ResponseHeadersPolicy"
declare -A want=(
  [x-content-type-options]='nosniff'
  [x-frame-options]='DENY'
  [strict-transport-security]='max-age=63072000; includeSubDomains; preload'
  [referrer-policy]='strict-origin-when-cross-origin'
)
for h in "${!want[@]}"; do
  got=$(hdr "$BASE/" "$h")
  [ "$got" = "${want[$h]}" ] && ok "$h" || bad "$h = '$got' (expected '${want[$h]}')"
done
csp=$(hdr "$BASE/" content-security-policy)
for d in "default-src 'self'" "frame-ancestors 'none'" "object-src 'none'"; do
  case "$csp" in *"$d"*) ok "CSP contains: $d";; *) bad "CSP missing: $d";; esac
done
for d in ${EXPECTED_ORIGINS+"${EXPECTED_ORIGINS[@]}"}; do
  case "$csp" in *"$d"*) ok "connect-src allows: $d";; *) bad "connect-src missing: $d";; esac
done
[ ${#EXPECTED_ORIGINS[@]} -gt 0 ] || printf '  INFO  no expected origins passed; connect-src not checked\n'

echo "== immutable assets"
asset=$(curl -sS "$BASE/" | grep -o '/_next/static/[^"]*\.js' | head -1)
if [ -n "$asset" ]; then
  cc=$(hdr "$BASE$asset" cache-control)
  case "$cc" in *immutable*) ok "$asset -> $cc";; *) bad "$asset -> '$cc'";; esac
else
  bad "could not find a /_next/static asset in the homepage"
fi

echo "== edge cache on HTML (the point of the migration)"
# CF-Cache-Status on static assets is documented as probabilistic, so this is
# informational: two misses in a row is a smell, not proof of failure.
curl -sS -o /dev/null "$BASE/"
printf '  INFO  cf-cache-status (2nd request) = %s\n' "$(hdr "$BASE/" cf-cache-status)"

[ "$fail" = 0 ] && echo "ALL GATES PASSED" || echo "GATES FAILED — do not start Phase 1"
exit "$fail"
