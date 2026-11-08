#!/usr/bin/env bash
# Checks the edges scenario measures what it should (milestone 3, T3):
#   - a quick fixed-window run finishes in under a minute and peaks at 1.8× the limit or more.
#     Bursts on both sides of a boundary give up to 2×; the trickle alone reaches only about 1.3×,
#     so this shows the bursts really straddle a boundary. "Over the limit" wasn't enough: with
#     the bursts moved mid-window, the trickle still reached 129 against 100.
#   - a quick sliding-window-log run never goes over the limit
#   - re-running the analysis on saved output gives the same summary
# Each run also prints how full the fixed windows either side of each burst edge got
# (bench/edges-report.ts), and a failure annotation carries that line (milestone 5, T0).
# CI runs it too (T7). Needs Docker; starts the stack itself.
set -euo pipefail

cd "$(dirname "$0")/.."
out="bench/results/edges-check-$$"
trap 'rm -rf "$out"' EXIT
failures=0
fail() {
  printf 'FAIL %s\n' "$1" >&2
  # In GitHub Actions, also as an annotation, which the API shows without admin rights.
  if [[ -n "${GITHUB_ACTIONS:-}" ]]; then printf '::error title=edges-check::%s\n' "$1"; fi
  failures=$((failures + 1))
}
# A command that fails outside a check (the runner, say) stops the script under set -e.
# Say where, rather than exiting with no message.
trap 'fail "stopped at line $LINENO: $(sed -n "${LINENO}p" "$0" | sed "s/^ *//")"' ERR

# Peak per window and the limit, from a results directory's chart.json.
peak() {
  node -e '
    const c = JSON.parse(require("fs").readFileSync(process.argv[1] + "/chart.json", "utf8"));
    console.log(c.algorithms[0].peakPerWindow, c.limit);
  ' "$1"
}

for algorithm in fixed-window sliding-window-log; do
  start=$(date +%s)
  npm run --silent bench -- --scenario edges --algorithm "$algorithm" --quick --out "$out/$algorithm" >/dev/null
  seconds=$(($(date +%s) - start))
  dir="$(ls -d "$out/$algorithm"/0008-edges-*)"
  read -r value limit <<<"$(peak "$dir")"
  # How full the windows either side of each burst boundary got (milestone 5, T0).
  fill="$(node --experimental-strip-types --disable-warning=ExperimentalWarning bench/edges-report.ts "$dir" | sed 's/^[^:]*: //')"
  echo "     $algorithm: $fill"

  if [[ "$algorithm" == fixed-window ]]; then
    if ((value * 10 >= limit * 18)); then
      echo "ok   fixed-window: peak $value per window against a limit of $limit, the boundary burst"
    else
      fail "fixed-window: peak $value is under 1.8× the limit of $limit, so the bursts missed the boundary ($fill)"
    fi
    if ((seconds < 60)); then
      echo "ok   fixed-window quick run took ${seconds}s"
    else
      fail "fixed-window quick run took ${seconds}s, not under 60"
    fi
  else
    if ((value <= limit)); then
      echo "ok   sliding-window-log: peak $value per window, never over the limit of $limit (${seconds}s)"
    else
      fail "sliding-window-log: peak $value per window, over the limit of $limit ($fill)"
    fi
  fi

  cp "$dir/summary.md" "$dir/summary.first.md"
  npm run --silent bench:analyse -- "$dir" >/dev/null
  if cmp -s "$dir/summary.md" "$dir/summary.first.md"; then
    echo "ok   $algorithm: re-running the analysis gives the same summary"
  else
    fail "$algorithm: re-running the analysis changed the summary"
  fi
done

if ((failures > 0)); then
  echo "$failures check(s) failed" >&2
  exit 1
fi
