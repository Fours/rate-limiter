#!/usr/bin/env bash
# Checks the milestone 2 demo: two copies of the example server share one Redis, so a client
# limited by one copy is limited by the other too. Runs once per algorithm.
#
# Usage: demo-check.sh [algorithm ...]   (default: all five)
# Needs a built dist/ (npm run build) and a Redis at REDIS_URL (default: the test Redis).
set -euo pipefail

cd "$(dirname "$0")/../.."
export REDIS_URL="${REDIS_URL:-redis://localhost:6390}"
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
  for port in 3001 3002; do
    ALGORITHM="$algorithm" PORT="$port" node --experimental-strip-types examples/basic/server.ts >/dev/null &
    pids+=($!)
  done
  wait_for 3001
  wait_for 3002

  # Fixed windows end on the minute (the demo's window is 60 s), and a boundary mid-check would
  # reset the count. Wait until the check has at least 5 s of the window left.
  if [[ "$algorithm" == fixed-window ]]; then
    while (($(date +%s) % 60 >= 55)); do sleep 1; done
  fi

  # A new client each run, so state left by an earlier algorithm or run can't decide this one.
  client="demo-check-$algorithm-$$-$RANDOM"
  allowed=0
  until [[ "$(status 3001 "$client")" == 429 ]]; do
    allowed=$((allowed + 1))
    if ((allowed > 20)); then
      echo "FAIL $algorithm: port 3001 never limited the client" >&2
      exit 1
    fi
  done
  other="$(status 3002 "$client")"
  if [[ "$other" != 429 ]]; then
    echo "FAIL $algorithm: 3001 limited the client after $allowed, but 3002 answered $other" >&2
    exit 1
  fi
  echo "ok   $algorithm: 3001 allowed $allowed then limited; 3002 limited the same client"
  stop_servers
done
