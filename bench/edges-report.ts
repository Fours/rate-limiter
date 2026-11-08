// One line per edges run for bench/edges-check.sh: how full the fixed windows either side of each
// burst boundary got (milestone 5, T0), so a failed boundary check says whether the bursts landed
// where the scenario aims them.
//
// Usage: node --experimental-strip-types bench/edges-report.ts <results-dir>
import { fileURLToPath } from 'node:url';
import { loadResults } from './analyse.ts';
import { edgeFill, type EdgeFill } from './analysis.ts';

export function fillLine(fills: readonly EdgeFill[], limit: number): string {
  if (fills.length === 0) return 'no bursts found';
  const each = fills.map(
    (f) =>
      `${String(f.before)} before, ${f.afterMs === undefined ? `under ${String(limit)} after` : `${String(limit)} after within ${String(Math.round(f.afterMs))} ms`}`,
  );
  return `each burst edge, slowest client: ${each.join('; ')}`;
}

async function main(dir: string): Promise<void> {
  const results = await loadResults(dir);
  for (const [algorithm, runs] of results.algorithms) {
    for (const run of runs) {
      const fills = edgeFill(run.records, results.windowMs, results.limit);
      console.log(`${algorithm} run ${String(run.meta.run)}: ${fillLine(fills, results.limit)}`);
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [dir] = process.argv.slice(2);
  if (dir === undefined) {
    console.error('Usage: node --experimental-strip-types bench/edges-report.ts <results-dir>');
    process.exit(2);
  }
  await main(dir);
}
