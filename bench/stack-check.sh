#!/usr/bin/env bash
# Checks the milestone 3 stack (docker-compose.yml): nginx spreads requests over three instances,
# and they still hold each client to one shared limit. Runs once per algorithm, starting the stack
# fresh each time, and leaves the last one running.
#
# Usage: bench/stack-check.sh [algorithm ...]   (default: sliding-window-counter)
#   bench/stack-check.sh token-bucket leaky-bucket fixed-window sliding-window-log sliding-window-counter
#
# Expects bench/rules/default.yaml: /work, 10 per minute. STACK_PORT overrides the port (8080).
set -euo pipefail

cd "$(dirname "$0")/.."
port="${STACK_PORT:-8080}"
base="http://localhost:$port"
algorithms=("$@")
if ((${#algorithms[@]} == 0)); then algorithms=(sliding-window-counter); fi
limit=10

failures=0
pass() { printf 'ok   %s\n' "$1"; }
fail() {
  printf 'FAIL %s\n' "$1" >&2
  failures=$((failures + 1))
}

# "<status> <instance>" for one request. Extra arguments are curl headers.
hit() {
  local path="$1"
  shift
  curl -s -o /dev/null -w '%{http_code} %header{x-instance}\n' "$@" "$base$path"
}

distinct() { sort -u | grep -c . || true; }

echo "Building the app image"
docker compose --progress quiet build

for algorithm in "${algorithms[@]}"; do
  # The leaky bucket allows no burst (decision 0014): one request, then one every 6 s.
  expected=$limit
  if [[ "$algorithm" == leaky-bucket ]]; then expected=1; fi

  echo
  echo "== $algorithm (expect $expected of a burst allowed)"
  # Recreated, so each algorithm starts with an empty Redis: it has no persistence, and it's this
  # stack's own, so nothing else is lost.
  ALGORITHM="$algorithm" docker compose up -d --wait --force-recreate >/dev/null 2>&1

  # 1. Round robin reaches every instance. /healthz sits before the limiter, so this spends nothing.
  served="$(for _ in $(seq 1 30); do hit /healthz; done)"
  instances="$(awk '{ print $2 }' <<<"$served" | distinct)"
  if ((instances == 3)); then
    pass "30 requests spread over all 3 instances: $(awk '{ print $2 }' <<<"$served" | sort | uniq -c | awk '{ printf "%s×%s ", $2, $1 }')"
  else
    fail "30 requests reached $instances instance(s), not 3"
  fi

  # Fixed windows reset on the minute (the rule's window is 60 s), and a boundary during checks
  # 2 to 4 would reset the count. They take about a second, so start with at least 5 s left.
  if [[ "$algorithm" == fixed-window ]]; then
    while (($(date +%s) % 60 >= 55)); do sleep 1; done
  fi

  # 2. One client, 30 requests: the three instances share one limit.
  a="stack-check-a-$$-$RANDOM"
  results="$(for _ in $(seq 1 30); do hit /work -H "x-api-key: $a"; done)"
  allowed="$(grep -c '^200 ' <<<"$results" || true)"
  denied_on="$(grep '^429 ' <<<"$results" | awk '{ print $2 }' | distinct)"
  all_on="$(awk '{ print $2 }' <<<"$results" | distinct)"
  # Denials from several instances, so a load balancer stuck on one instance can't pass.
  if ((allowed == expected && denied_on >= 2 && all_on == 3)); then
    pass "one client: $allowed of 30 allowed across 3 instances, denied by $denied_on of them"
  else
    fail "one client: $allowed of 30 allowed (want $expected), on $all_on instance(s), denied by $denied_on"
  fi

  # 3. A second client isn't affected by the first being limited.
  b="stack-check-b-$$-$RANDOM"
  allowed_b="$(for _ in $(seq 1 $((expected + 1))); do hit /work -H "x-api-key: $b"; done | grep -c '^200 ' || true)"
  if ((allowed_b == expected)); then
    pass "a second client still gets its own $expected"
  else
    fail "a second client got $allowed_b allowed, not $expected"
  fi

  # 4. A client can't pick a new identity by forging X-Forwarded-For: the app trusts one hop,
  # nginx's, and nginx appends the real address. Every request comes from this host, so one client.
  forged="$(for i in $(seq 1 $((expected + 1))); do hit /work -H "x-forwarded-for: 198.51.100.$i"; done)"
  allowed_f="$(grep -c '^200 ' <<<"$forged" || true)"
  if ((allowed_f == expected)); then
    pass "forged X-Forwarded-For: $allowed_f of $((expected + 1)) allowed, one client"
  else
    fail "forged X-Forwarded-For: $allowed_f of $((expected + 1)) allowed (want $expected)"
  fi
done

# 5. Redis is reachable inside the stack but not from the host.
echo
ports="$(docker compose ps redis --format '{{.Ports}}')"
if [[ "$ports" == *"->"* ]]; then
  fail "Redis is published on the host: $ports"
else
  pass "Redis has no port on the host ($ports, inside the stack only)"
fi
if [[ "$(docker compose exec -T redis redis-cli ping 2>/dev/null)" == PONG ]]; then
  pass "Redis answers inside the stack"
else
  fail "Redis doesn't answer inside the stack"
fi

echo
if ((failures > 0)); then
  echo "$failures check(s) failed" >&2
  exit 1
fi
echo "All checks passed. The stack is still running ($base); stop it with npm run stack:down."
