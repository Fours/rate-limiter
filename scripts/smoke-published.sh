#!/usr/bin/env bash
# Installs the published package from npm into an empty folder and runs the README's quick start,
# on each Node version the package supports, in Docker, so nothing from this repo leaks in.
# Passes when POST /login gets five 200s and then a 429.
#
# Usage: scripts/smoke-published.sh [version]   (default: package.json's version)
#        scripts/smoke-published.sh path/to/package.tgz   (an `npm pack` tarball, before publishing)
set -euo pipefail

cd "$(dirname "$0")/.."
version="${1:-$(node -p "require('./package.json').version")}"
mount=()
spec="@kylewillett/rate-limiter@$version"
if [[ "$version" == *.tgz ]]; then
  mount=(-v "$(cd "$(dirname "$version")" && pwd)/$(basename "$version"):/pkg.tgz:ro")
  spec=/pkg.tgz
fi
# Keep in step with ci.yml's matrix.
node_versions=(22.23.4 24.22.1)

# The README's first ts block under "## Quick start", as written, minus the shutdown line, which
# would stop the limiter as soon as it started.
quickstart="$(awk '/^## Quick start/{s=1} s&&/^```ts/{c=1;next} c&&/^```/{exit} c' README.md |
  grep -v 'limiter.close()')"
if [[ -z "$quickstart" ]]; then
  echo "No quick start found in README.md" >&2
  exit 1
fi

for node in "${node_versions[@]}"; do
  echo "== Node $node, $spec"
  docker run --rm -i ${mount[@]+"${mount[@]}"} -e SPEC="$spec" -e QUICKSTART="$quickstart" "node:$node-slim" bash -s <<'EOF'
set -euo pipefail
mkdir /app && cd /app
npm init -y >/dev/null
npm pkg set type=module
npm install --no-audit --no-fund "$SPEC" express
printf '%s\n' "$QUICKSTART" > server.js
node server.js &
for _ in $(seq 50); do
  node -e "fetch('http://localhost:3000/').then(()=>process.exit(0),()=>process.exit(1))" && break
  sleep 0.2
done
codes="$(node --input-type=module -e "
  const codes = [];
  for (let i = 0; i < 6; i++) codes.push((await fetch('http://localhost:3000/login', { method: 'POST' })).status);
  console.log(codes.join(' '));
")"
echo "POST /login x6: $codes"
[[ "$codes" == "200 200 200 200 200 429" ]]
EOF
done
echo "Quick start works on Node ${node_versions[*]}."
