// Turns a results directory into summary.md and chart.json, next to the data, so the numbers can
// always be rebuilt from the raw records without rerunning anything.
//
// Usage: npm run bench:analyse -- <results-dir>
//
// Layout it reads (written by the T3 runner):
//   <results-dir>/setup.json                         machine, versions, commit, command
//   <results-dir>/<algorithm>/run-<n>/meta.json      RunMeta
//   <results-dir>/<algorithm>/run-<n>/requests.jsonl one RequestRecord per line
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  byAlgorithmOrder,
  chartFor,
  runMetrics,
  summariseRuns,
  summaryTable,
  type AlgorithmChart,
  type RequestRecord,
  type Run,
  type RunMeta,
} from './analysis.ts';

export interface Results {
  readonly scenario: string;
  readonly limit: number;
  readonly windowMs: number;
  /** Runs per algorithm, in table order. */
  readonly algorithms: ReadonlyMap<string, readonly Run[]>;
}

export async function loadResults(dir: string): Promise<Results> {
  const algorithms = new Map<string, Run[]>();
  const names = (await subdirectories(dir)).sort(byAlgorithmOrder);
  for (const algorithm of names) {
    const runDirs = (await subdirectories(join(dir, algorithm))).filter((d) => /^run-\d+$/.test(d));
    const runs: Run[] = [];
    for (const runDir of runDirs.sort(byRunNumber)) {
      runs.push(await loadRun(join(dir, algorithm, runDir)));
    }
    if (runs.length > 0) algorithms.set(algorithm, runs);
  }

  const metas = [...algorithms.values()].flat().map((r) => r.meta);
  const first = metas[0];
  if (first === undefined) throw new Error(`${dir}: no runs found`);
  // One table compares like with like: every run must share the scenario and the rule.
  for (const m of metas) {
    if (m.scenario !== first.scenario || m.limit !== first.limit || m.windowMs !== first.windowMs) {
      throw new Error(
        `${dir}: ${m.algorithm} run ${String(m.run)} has a different scenario or rule from ${first.algorithm} run ${String(first.run)}`,
      );
    }
  }
  return { scenario: first.scenario, limit: first.limit, windowMs: first.windowMs, algorithms };
}

export interface Analysis {
  readonly summary: string;
  readonly chart: {
    readonly limit: number;
    readonly windowMs: number;
    readonly algorithms: AlgorithmChart[];
  };
}

export function analyse(results: Results): Analysis {
  const rows = [...results.algorithms].map(([algorithm, runs]) =>
    summariseRuns(algorithm, runs.map(runMetrics)),
  );
  return {
    summary: summaryTable(results.scenario, results, rows),
    chart: {
      limit: results.limit,
      windowMs: results.windowMs,
      algorithms: [...results.algorithms.values()].map(chartFor),
    },
  };
}

async function loadRun(dir: string): Promise<Run> {
  const meta = JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8')) as RunMeta;
  const text = await readFile(join(dir, 'requests.jsonl'), 'utf8');
  const records = text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line, i) => {
      try {
        return JSON.parse(line) as RequestRecord;
      } catch (error) {
        throw new Error(`${dir}/requests.jsonl line ${String(i + 1)}: not valid JSON`, {
          cause: error,
        });
      }
    });
  return { meta, records };
}

async function subdirectories(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  return entries.filter((e) => e.isDirectory()).map((e) => e.name);
}

function byRunNumber(a: string, b: string): number {
  return Number(a.slice(4)) - Number(b.slice(4));
}

async function main(dir: string | undefined): Promise<void> {
  if (dir === undefined) {
    console.error('Usage: npm run bench:analyse -- <results-dir>');
    process.exitCode = 1;
    return;
  }
  const { summary, chart } = analyse(await loadResults(dir));
  await writeFile(join(dir, 'summary.md'), summary);
  await writeFile(join(dir, 'chart.json'), `${JSON.stringify(chart, null, 2)}\n`);
  console.log(summary);
  console.log(`Wrote summary.md and chart.json in ${basename(dir)}/`);
}

// Run only as a script, so tests can import loadResults and analyse without side effects.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main(process.argv[2]);
}
