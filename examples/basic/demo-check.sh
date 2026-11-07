#!/usr/bin/env bash
# Checks the milestone 2 demo: two copies of the example server share one Redis, so a client
# limited by one copy is limited by the other too. Runs once per algorithm.
#
# Usage: demo-check.sh [algorithm ...]   (default: all five)
# Needs a built dist/ (npm run build) and a Redis at REDIS_URL (default: the test Redis).
# Uses ports 3001 to 3003, or DEMO_PORT to DEMO_PORT + 2.
set -euo pipefail

cd "$(dirname "$0")/../.."
export REDIS_URL="${REDIS_URL:-redis://localhost:6390}"
p1="${DEMO_PORT:-3001}"
p2=$((p1 + 1))
p3=$((p1 + 2))
algorithms=("$@")
if ((${#algorithms[@]} == 0)); then
  algorithms=(token-bucket leaky-bucket fixed-window sliding-window-log sliding-window-counter)
fi

pids=()
stop_servers() {
  if ((${#pids[@]} > 0)); then kill "${pids[@]}" 2>/dev/null || true; wait "${pids[@]}" 2>/dev/null || true; fi
  pids=()
}
trap stop_servers EXIT

# Any response counts, even a 429: the check below uses its own client, so these probes from
# this IP never use up its limit.
wait_for() {
  for _ in $(seq 1 100); do
    curl -s -o /dev/null "http://localhost:$1/" 2>/dev/null && return 0
    sleep 0.1
  done
  echo "Server on port $1 didn't start" >&2
  return 1
}

# Status code of one GET / from a port, as a given client.
status() { curl -s -o /dev/null -w '%{http_code}' -H "x-api-key: $2" "http://localhost:$1/"; }

for algorithm in "${algorithms[@]}"; do
  for port in $p1 $p2; do
    ALGORITHM="$algorithm" PORT="$port" node --experimental-strip-types examples/basic/server.ts >/dev/null &
    pids+=($!)
  done
  wait_for $p1
  wait_for $p2

  # Fixed windows end on the minute (the demo's window is 60 s), and a boundary mid-check would
  # reset the count. Wait until the check has at least 5 s of the window left.
  if [[ "$algorithm" == fixed-window ]]; then
    while (($(date +%s) % 60 >= 55)); do sleep 1; done
  fi

  # A new client each run, so state left by an earlier algorithm or run can't decide this one.
  client="demo-check-$algorithm-$$-$RANDOM"
  allowed=0
  until [[ "$(status $p1 "$client")" == 429 ]]; do
    allowed=$((allowed + 1))
    if ((allowed > 20)); then
      echo "FAIL $algorithm: port $p1 never limited the client" >&2
      exit 1
    fi
  done
  other="$(status $p2 "$client")"
  if [[ "$other" != 429 ]]; then
    echo "FAIL $algorithm: $p1 limited the client after $allowed, but $p2 answered $other" >&2
    exit 1
  fi
  echo "ok   $algorithm: $p1 allowed $allowed then limited; $p2 limited the same client"
  stop_servers
done

# Milestone 4: with Redis unreachable, the example still answers, from its in-memory fallback,
# and logs the switch through onFallback.
out="$(mktemp)"
REDIS_URL=redis://localhost:1 PORT=$p3 node --experimental-strip-types examples/basic/server.ts >"$out" 2>&1 &
pids+=($!)
wait_for $p3
code="$(status $p3 "demo-check-fallback-$$")"
sleep 0.2
if [[ "$code" == 200 ]] && grep -q 'Answering from the in-memory fallback' "$out"; then
  echo "ok   Redis unreachable: answered $code from the fallback, and logged it once"
else
  echo "FAIL Redis unreachable: answered $code; log was:" >&2
  cat "$out" >&2
  exit 1
fi
if (($(grep -c 'in-memory fallback' "$out") != 1)); then
  echo "FAIL Redis unreachable: the fallback was logged more than once" >&2
  exit 1
fi
stop_servers
rm -f "$out"
