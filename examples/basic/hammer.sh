#!/usr/bin/env bash
# Sends requests to the example server and prints the status and rate-limit
# headers for each one.
#
# Usage: hammer.sh [count] [method] [path] [api-key]
#   hammer.sh                         12 GET requests to /
#   hammer.sh 5 POST /orders          free tier: the 4th order is limited
#   hammer.sh 5 POST /orders demo-pro-key   pro tier: only the global limit applies
#
# BASE_URL overrides the server address (default http://localhost:3000).
set -euo pipefail

count="${1:-12}"
method="${2:-GET}"
path="${3:-/}"
api_key="${4:-}"
base_url="${BASE_URL:-http://localhost:3000}"

curl_args=(-s -o /dev/null -D - -X "$method")
if [[ -n "$api_key" ]]; then
  curl_args+=(-H "x-api-key: $api_key")
fi

# One header's value from $headers, matched case-insensitively, or "-" if absent.
header() {
  awk -v name="$1" '
    tolower($1) == tolower(name ":") { print $2; found = 1 }
    END { if (!found) print "-" }
  ' <<<"$headers"
}

row() { printf '%-4s %-6s %-6s %-10s %-6s %s\n' "$@"; }

for ((i = 1; i <= count; i++)); do
  # No separate "is it up?" request first: it would use up one of the client's tokens.
  if ! raw="$(curl "${curl_args[@]}" "$base_url$path")"; then
    echo "No server at $base_url. Start it with: npm run example" >&2
    exit 1
  fi
  headers="$(tr -d '\r' <<<"$raw")"
  if ((i == 1)); then row '#' 'status' 'limit' 'remaining' 'reset' 'retry-after'; fi
  status="$(head -n 1 <<<"$headers" | awk '{ print $2 }')"
  row "$i" "$status" \
    "$(header RateLimit-Limit)" "$(header RateLimit-Remaining)" \
    "$(header RateLimit-Reset)" "$(header Retry-After)"
done
