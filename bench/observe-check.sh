#!/usr/bin/env bash
# Checks the stack's observability profile (milestone 4, T3): Prometheus scrapes all three app
# instances, ratelimit_decisions_total rises under traffic, Grafana serves the provisioned
# dashboard without a login, and plain stack:up still starts neither of them.
#
# Usage: bench/observe-check.sh
#
# Starts the stack with npm run stack:observe and stops it at the end. STACK_PORT,
# PROMETHEUS_PORT and GRAFANA_PORT override the ports (8080, 9090, 3001). Expects
# bench/rules/default.yaml: /work, 10 per minute.
set -euo pipefail

cd "$(dirname "$0")/.."
base="http://localhost:${STACK_PORT:-8080}"
prometheus="http://localhost:${PROMETHEUS_PORT:-9090}"
grafana="http://localhost:${GRAFANA_PORT:-3001}"

failures=0
pass() { printf 'ok   %s\n' "$1"; }
fail() {
  printf 'FAIL %s\n' "$1" >&2
  failures=$((failures + 1))
}

# One number from a Prometheus instant query: the first result's value, or 0 when there is none.
query() {
  curl -s --get "$prometheus/api/v1/query" --data-urlencode "query=$1" |
    node -e '
      let s = "";
      process.stdin.on("data", (d) => (s += d)).on("end", () => {
        const [first] = JSON.parse(s).data.result;
        console.log(first === undefined ? 0 : Number(first.value[1]));
      });
    '
}

# Waits up to $2 seconds for the query in $1 to return more than $3.
wait_above() {
  local value=0
  for _ in $(seq 1 "$2"); do
    value="$(query "$1")"
    if node -e "process.exit(Number('$value') > Number('$3') ? 0 : 1)"; then
      echo "$value"
      return
    fi
    sleep 1
  done
  echo "$value"
}

echo "Starting the stack with Prometheus and Grafana"
npm run --silent stack:observe >/dev/null 2>&1

# 1. Every instance is a target, and up. Scrapes go to each instance, not through nginx.
up="$(wait_above 'count(up{job="rate-limiter"} == 1)' 30 2)"
if [[ "$up" == 3 ]]; then
  pass "Prometheus scrapes all 3 instances"
else
  fail "Prometheus sees $up instance(s) up, not 3"
fi
instances="$(curl -s "$prometheus/api/v1/targets" | node -e '
  let s = "";
  process.stdin.on("data", (d) => (s += d)).on("end", () => {
    const names = JSON.parse(s).data.activeTargets.map((t) => t.labels.instance);
    console.log([...new Set(names)].sort().join(","));
  });
')"
if [[ "$instances" == app-1,app-2,app-3 ]]; then
  pass "targets are app-1, app-2 and app-3, scraped directly"
else
  fail "targets are $instances, not app-1,app-2,app-3"
fi

# 2. Traffic moves the counters: 5 clients send 15 requests each against a limit of 10, so
# some are denied, and every instance decides some.
before="$(query 'sum(ratelimit_decisions_total)')"
for c in $(seq 1 5); do
  for _ in $(seq 1 15); do
    curl -s -o /dev/null -H "x-api-key: observe-check-$$-$c" "$base/work"
  done
done
total="$(wait_above 'sum(ratelimit_decisions_total)' 20 "$((${before%.*} + 74))")"
if [[ "${total%.*}" -ge "$((${before%.*} + 75))" ]]; then
  pass "ratelimit_decisions_total rose from $before to $total under 75 requests"
else
  fail "ratelimit_decisions_total went from $before to $total, not up by 75"
fi
denied="$(query 'sum(ratelimit_decisions_total{outcome="denied"})')"
if [[ "${denied%.*}" -ge 25 ]]; then
  pass "denials counted: $denied"
else
  fail "denials counted: $denied, want at least 25"
fi
deciding="$(query 'count(sum by (instance) (ratelimit_decisions_total) > 0)')"
if [[ "$deciding" == 3 ]]; then
  pass "all 3 instances recorded decisions"
else
  fail "$deciding instance(s) recorded decisions, not 3"
fi

# 3. Grafana: the provisioned dashboard opens with no credentials.
status="$(curl -s -o /dev/null -w '%{http_code}' "$grafana/api/dashboards/uid/rate-limiter")"
title="$(curl -s "$grafana/api/dashboards/uid/rate-limiter" | node -e '
  let s = "";
  process.stdin.on("data", (d) => (s += d)).on("end", () => {
    try { console.log(JSON.parse(s).dashboard.title); } catch { console.log(""); }
  });
')"
if [[ "$status" == 200 && "$title" == "Rate limiter" ]]; then
  pass "Grafana serves the \"$title\" dashboard without a login"
else
  fail "Grafana answered $status for the dashboard, titled \"$title\""
fi
# The data source answers through Grafana, so the panels have data to draw.
ds="$(curl -s -o /dev/null -w '%{http_code}' --get "$grafana/api/datasources/proxy/uid/prometheus/api/v1/query" --data-urlencode 'query=sum(ratelimit_decisions_total)')"
if [[ "$ds" == 200 ]]; then
  pass "Grafana reaches Prometheus through the provisioned data source"
else
  fail "Grafana's Prometheus data source answered $ds"
fi

# 4. Plain stack:up leaves the observability profile out. Start from nothing, since a plain
# `up` leaves profile services that are already running alone.
npm run --silent stack:down >/dev/null 2>&1
npm run --silent stack:up >/dev/null 2>&1
running="$(docker compose --profile observability ps --format '{{.Service}}' | sort | tr '\n' ' ')"
if [[ "$running" != *prometheus* && "$running" != *grafana* && "$running" == *app-1* ]]; then
  pass "npm run stack:up starts the stack without Prometheus or Grafana: $running"
else
  fail "npm run stack:up started: $running"
fi
if [[ "$(curl -s -o /dev/null -w '%{http_code}' "$base/metrics")" == 404 ]]; then
  pass "without METRICS=1, the apps serve no /metrics"
else
  fail "the apps serve /metrics without METRICS=1"
fi
npm run --silent stack:down >/dev/null 2>&1

echo
if ((failures > 0)); then
  echo "$failures check(s) failed" >&2
  exit 1
fi
echo "All checks passed. The stack is stopped."
