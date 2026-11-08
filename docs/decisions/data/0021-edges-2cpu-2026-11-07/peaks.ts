// For each results directory given: the sliding window log's peak per window with a fixed 2 ms
// of slack (decision 0017) and with each request's own slack (0021), the shortest span of
// limit + 1 allowed requests by arrival, and the limiter's p99 and max.
// Usage: node --experimental-strip-types docs/decisions/data/0021-edges-2cpu-2026-11-07/peaks.ts <dir>...
import { loadResults } from '../../../../bench/analyse.ts';
import { maxInWindow, percentile, peakPerWindow, RESOLUTION_MS } from '../../../../bench/analysis.ts';

for (const dir of process.argv.slice(2)) {
  const { algorithms, windowMs, limit } = await loadResults(dir);
  for (const [algorithm, runs] of algorithms) {
    for (const run of runs) {
      const allowed = run.records.filter((r) => r.status === 200);
      const clients = Map.groupBy(allowed, (r) => r.client);
      let fixed = 0;
      let shortest = Infinity;
      for (const own of clients.values()) {
        fixed = Math.max(fixed, maxInWindow(own.map((r) => ({ t: r.t, slack: RESOLUTION_MS })), windowMs));
        const ts = own.map((r) => r.t).sort((a, b) => a - b);
        for (let i = 0; i + limit < ts.length; i++) shortest = Math.min(shortest, (ts[i + limit] as number) - (ts[i] as number));
      }
      const lim = run.records.flatMap((r) => (r.limiterMs === undefined ? [] : [r.limiterMs]));
      console.log(
        [dir.split('/').slice(-2).join('/'), algorithm, `fixed 2 ms: ${String(fixed)}`, `own slack: ${String(peakPerWindow(run.records, windowMs).peak)}`,
          `shortest ${String(limit + 1)}-span: ${String(shortest)} ms`, `limiter p99 ${percentile(lim, 99).toFixed(2)} ms, max ${Math.max(...lim).toFixed(2)} ms`].join(' | '),
      );
    }
  }
}
