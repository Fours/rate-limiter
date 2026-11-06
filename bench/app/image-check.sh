#!/usr/bin/env bash
# Builds the benchmark app's image and checks it starts and answers /healthz. Redis points at
# nothing on purpose: /healthz must answer without it, since it sits in front of the limiter.
#
# Usage: bench/app/image-check.sh   (from anywhere; Docker required)
set -euo pipefail

cd "$(dirname "$0")/../.."
image=rate-limiter-bench:check
name="rate-limiter-bench-check-$$"
port="${PORT:-3099}"

docker build -q -f bench/app/Dockerfile -t "$image" . >/dev/null
trap 'docker rm -f "$name" >/dev/null 2>&1 || true' EXIT
docker run -d --name "$name" -p "$port:3000" \
  -e INSTANCE=check -e REDIS_URL=redis://127.0.0.1:1 "$image" >/dev/null

for _ in $(seq 1 100); do
  if headers="$(curl -s -D - -o /dev/null "http://localhost:$port/healthz")" && [[ -n "$headers" ]]; then
    break
  fi
  sleep 0.1
done
status="$(head -n 1 <<<"$headers" | awk '{ print $2 }')"
instance="$(tr -d '\r' <<<"$headers" | awk -F': ' 'tolower($1) == "x-instance" { print $2 }')"
if [[ "$status" != 200 || "$instance" != check ]]; then
  echo "FAIL: /healthz answered status '${status:-none}', X-Instance '${instance:-none}'" >&2
  docker logs "$name" >&2 || true
  exit 1
fi
echo "ok   image builds, starts and answers /healthz ($(docker run --rm --entrypoint node "$image" -v))"
