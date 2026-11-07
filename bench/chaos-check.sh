#!/usr/bin/env bash
# A short chaos check for CI (milestone 4, T6): with traffic flowing through the stack, kill
# Redis, then bring it back; then the same with a pause. It checks behaviour only: no request
# fails, the fallback answers while Redis is gone, every instance is back on the primary soon
# after it returns, and each instance logs both switches. Like the other CI checks, it compares
# no latency numbers (decision 0017). The measured version is npm run bench -- --scenario chaos
# (decision 0010).
#
# Usage: bench/chaos-check.sh [kill|pause ...]   (default: both)
#
# Starts the stack itself, fresh for each case, and stops it at the end. STACK_PORT overrides the
# port (8080). ALGORITHM picks the algorithm (default sliding-window-counter).
set -euo pipefail

cd "$(dirname "$0")/.."
base="http://localhost:${STACK_PORT:-8080}"
cases=("$@")
if ((${#cases[@]} == 0)); then cases=(kill pause); fi
outage_s=5
recover_within_s=15
log="$(mktemp)"
traffic_pid=""

failures=0
pass() { printf 'ok   %s\n' "$1"; }
fail() {
  printf 'FAIL %s\n' "$1" >&2
  # In GitHub Actions, also as an annotation, which the API shows without admin rights.
  if [[ -n "${GITHUB_ACTIONS:-}" ]]; then printf '::error title=chaos-check::%s\n' "$1"; fi
  failures=$((failures + 1))
}

stop_traffic() {
  if [[ -n "$traffic_pid" ]]; then
    kill "$traffic_pid" 2>/dev/null || true
    wait "$traffic_pid" 2>/dev/null || true
    traffic_pid=""
  fi
}
cleanup() {
  stop_traffic
  rm -f "$log"
  # A paused Redis would keep the stack from stopping cleanly.
  docker compose unpause redis >/dev/null 2>&1 || true
  npm run --silent stack:down >/dev/null 2>&1 || true
}
trap cleanup EXIT

on_error() {
  fail "stopped at line $1: $(sed -n "${1}p" "$0" | sed 's/^ *//')"
  docker compose ps -a --format '{{.Service}}: {{.Status}}' >&2 || true
}
trap 'on_error $LINENO' ERR

# Requests one after another from 5 clients, until killed. One line each:
#   <status> <instance> <source>
# Status 000 is curl's for no response. Markers from the main script (# down, # up) land in the
# same file, so the lines between them are the outage.
traffic() {
  local i=0
  while :; do
    curl -s -o /dev/null --max-time 5 \
      -w '%{http_code} %header{x-instance} %header{x-ratelimit-source}\n' \
      -H "x-api-key: chaos-check-$$-$((i % 5))" "$base/work" >>"$log" || true
    i=$((i + 1))
  done
}

# Lines of one phase: before the first marker, between the two, or after the second.
phase() {
  awk -v want="$1" '
    /^# down/ { p = "outage"; next }
    /^# up/ { p = "after"; next }
    { if ((p == "" ? "before" : p) == want) print }
  ' "$log"
}
count() { grep -c . || true; }

for chaos_case in "${cases[@]}"; do
  case "$chaos_case" in
    kill) down=kill up=start downed=killed upped=started ;;
    pause) down=pause up=unpause downed=paused upped=unpaused ;;
    *)
      echo "Unknown case \"$chaos_case\": use kill or pause" >&2
      exit 2
      ;;
  esac
  echo
  echo "== Redis $downed, then $upped"
  ALGORITHM="${ALGORITHM:-sliding-window-counter}" \
    docker compose --progress quiet up -d --build --wait --force-recreate >/dev/null 2>&1
  : >"$log"

  traffic &
  traffic_pid=$!
  sleep 3
  docker compose --progress quiet "$down" redis >/dev/null
  echo '# down' >>"$log"
  sleep "$outage_s"
  docker compose --progress quiet "$up" redis >/dev/null
  echo '# up' >>"$log"

  # Back when the last 30 responses all came from the primary, which in round robin covers
  # every instance several times over.
  back=""
  for _ in $(seq 1 $((recover_within_s * 5))); do
    if [[ "$(phase after | tail -n 30 | awk '$3 == "primary"' | count)" == 30 ]]; then
      back=yes
      break
    fi
    sleep 0.2
  done
  sleep 1
  stop_traffic

  total="$(grep -vc '^#' "$log" || true)"
  failed="$(grep -v '^#' "$log" | awk '$1 != 200 && $1 != 429' | count)"
  if ((failed == 0)); then
    pass "no failed requests out of $total"
  else
    fail "$failed of $total requests failed: $(grep -v '^#' "$log" | awk '$1 != 200 && $1 != 429 { print $1 }' | sort | uniq -c | tr '\n' ' ')"
  fi

  during="$(phase outage | count)"
  fallback="$(phase outage | awk '$3 == "fallback"' | count)"
  if ((fallback > 0 && fallback * 10 >= during * 9)); then
    pass "the fallback answered $fallback of $during requests while Redis was $downed"
  else
    fail "the fallback answered $fallback of $during requests while Redis was $downed, want at least 90%"
  fi

  if [[ "$back" == yes ]]; then
    instances="$(phase after | tail -n 30 | awk '{ print $2 }' | sort -u | tr '\n' ' ')"
    pass "back on the primary within ${recover_within_s} s of the $up, on $instances"
  else
    fail "not back on the primary within ${recover_within_s} s of the $up"
  fi

  for app in app-1 app-2 app-3; do
    logs="$(docker compose logs --no-log-prefix "$app" 2>&1)"
    if grep -q 'answering from the in-memory fallback' <<<"$logs" &&
      grep -q 'back on the primary' <<<"$logs"; then
      pass "$app logged the switch to the fallback and back"
    else
      fail "$app didn't log both switches"
    fi
  done
done

echo
if ((failures > 0)); then
  echo "$failures check(s) failed" >&2
  exit 1
fi
echo "All checks passed. The stack is stopped."
