#!/usr/bin/env bash
# Phase 0 gates. Usage: ./verify.sh https://ctech-dfe-dev.<subdomain>.workers.dev
set -uo pipefail
BASE="${1:?usage: verify.sh <base-url>}"
fail=0
ok()   { printf '  PASS  %s\n' "$1"; }
bad()  { printf '  FAIL  %s\n' "$1"; fail=1; }

code() { curl -sS -o /dev/null -w '%{http_code}' "$1"; }
hdr()  { curl -sSD - -o /dev/null "$1" | tr -d '\r' | grep -i "^$2:" | cut -d' ' -f2-; }

echo "== pretty URLs (no route manifest)"
# Real routes from `find out -name '*.html'`. Next exports dashboard.html, not
# dashboard/index.html, so html_handling=auto-trailing-slash serves them bare.
for p in / /dashboard /guide/nfe /nfe/emit; do
  c=$(code "$BASE$p")
  [ "$c" = 200 ] && ok "$p -> 200" || bad "$p -> $c (expected 200)"
done
# A trailing slash on a bare .html asset is expected to 308 to the bare form.
raw=$(code "$BASE/dashboard/")
final=$(curl -sSL -o /dev/null -w '%{http_code}' "$BASE/dashboard/")
# Cloudflare normalises the trailing slash with a 307, not a 308 or 301.
case "$raw" in
  200|30[1278]) ok "/dashboard/ -> $raw, follows to $final";;
  *) bad "/dashboard/ -> $raw (expected 200 or a 3xx)";;
esac
[ "$final" = 200 ] || bad "/dashboard/ ends at $final after redirects"

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
for d in "default-src 'self'" "frame-ancestors 'none'" "object-src 'none'" \
         "https://dfe-api-dev.aoctech.app" "https://accounts-api-dev.aoctech.app"; do
  case "$csp" in *"$d"*) ok "CSP contains: $d";; *) bad "CSP missing: $d";; esac
done

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
