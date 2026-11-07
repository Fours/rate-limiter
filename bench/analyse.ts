// Turns a results directory into summary.md, spread.md and chart.json, next to the data, so the
// numbers can always be rebuilt from the saved data without rerunning anything.
//
// Usage: npm run bench:analyse -- <results-dir>
//
// Layout it reads (written by the T3 runner):
//   <results-dir>/setup.json                         machine, versions, commit, command
//   <results-dir>/<algorithm>/run-<n>/meta.json      RunMeta
//   <results-dir>/<algorithm>/run-<n>/requests.jsonl[.gz]  one RequestRecord per line
//   <results-dir>/<algorithm>/run-<n>/seconds.jsonl         per-second totals (ramp), used
//                                                           instead of the records when present
//   <results-dir>/<algorithm>/run-<n>/docker-stats.jsonl    CPU samples (ramp)
//
// Chaos results (milestone 4) have a level more, one directory per case, and each run also has
// faults.json, the fault times, and k6-summary.json, for k6's dropped iterations:
//   <results-dir>/{kill,pause}/<algorithm>/run-<n>/
import { access, readdir, readFile, writeFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  byAlgorithmOrder,
  chaosMetrics,
  chaosTable,
  chartFor,
  cpuTable,
  redisTable,
  runMetrics,
  spreadTable,
  summariseRuns,
  summaryTable,
  type AlgorithmChart,
  type ChaosRun,
  type Fault,
  type CpuSample,
  type RequestRecord,
  type SecondTotals,
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
  readonly spread: string;
  readonly chart: {
    readonly limit: number;
    readonly windowMs: number;
    readonly algorithms: AlgorithmChart[];
  };
}

export function analyse(results: Results): Analysis {
  const entries = [...results.algorithms];
  const metrics = entries.map(([algorithm, runs]) => [algorithm, runs.map(runMetrics)] as const);
  const rows = metrics.map(([algorithm, m]) => summariseRuns(algorithm, m));
  // Extra tables only where the runs recorded the data, so older summaries stay as they were.
  const extras = [cpuTable(entries), redisTable(entries)].filter((t) => t !== '');
  return {
    summary: [summaryTable(results.scenario, results, rows), ...extras].join('\n'),
    spread: spreadTable(results.scenario, metrics),
    chart: {
      limit: results.limit,
      windowMs: results.windowMs,
      // Runs kept only as per-second totals have no per-request series to chart.
      algorithms: entries
        .filter(([, runs]) => runs.every((r) => r.records.length > 0))
        .map(([, runs]) => chartFor(runs)),
    },
  };
}

async function loadRun(dir: string): Promise<Run> {
  const meta = JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8')) as RunMeta;
  const cpu = (await exists(join(dir, 'docker-stats.jsonl')))
    ? jsonLines<CpuSample>(
        join(dir, 'docker-stats.jsonl'),
        await readFile(join(dir, 'docker-stats.jsonl'), 'utf8'),
      )
    : undefined;
  const redisFile = join(dir, 'redis-calls.json');
  const redisCalls = (await exists(redisFile))
    ? (JSON.parse(await readFile(redisFile, 'utf8')) as Record<string, number>)
    : undefined;
  const extra = {
    ...(cpu === undefined ? {} : { cpu }),
    ...(redisCalls === undefined ? {} : { redisCalls }),
  };
  // Per-second totals win when present, so a ramp analysed from git (totals only) and one
  // analysed locally (raw records too) give the same summary.
  if (await exists(join(dir, 'seconds.jsonl'))) {
    const file = join(dir, 'seconds.jsonl');
    return {
      meta,
      records: [],
      seconds: jsonLines<SecondTotals>(file, await readFile(file, 'utf8')),
      ...extra,
    };
  }
  const plain = join(dir, 'requests.jsonl');
  const file = (await exists(plain)) ? plain : `${plain}.gz`;
  const raw = await readFile(file);
  const text = file.endsWith('.gz') ? gunzipSync(raw).toString('utf8') : raw.toString('utf8');
  return { meta, records: jsonLines<RequestRecord>(file, text), ...extra };
}

function jsonLines<T>(file: string, text: string): T[] {
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line, i) => {
      try {
        return JSON.parse(line) as T;
      } catch (error) {
        throw new Error(`${file} line ${String(i + 1)}: not valid JSON`, { cause: error });
      }
    });
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function subdirectories(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  return entries.filter((e) => e.isDirectory()).map((e) => e.name);
}

function byRunNumber(a: string, b: string): number {
  return Number(a.slice(4)) - Number(b.slice(4));
}

/** Analyses a results directory and writes summary.md, spread.md and chart.json into it. */
export async function analyseDir(dir: string): Promise<string> {
  const { summary, spread, chart } = analyse(await loadResults(dir));
  await writeFile(join(dir, 'summary.md'), summary);
  await writeFile(join(dir, 'spread.md'), spread);
  await writeFile(join(dir, 'chart.json'), `${JSON.stringify(chart, null, 2)}\n`);
  return summary;
}

const CHAOS_CASES = ['kill', 'pause'] as const;

/** The chaos runs in a results directory, per case present, each case's algorithms in order. */
export async function loadChaosResults(
  dir: string,
): Promise<[string, { limit: number; windowMs: number }, Map<string, ChaosRun[]>][]> {
  const cases: [string, { limit: number; windowMs: number }, Map<string, ChaosRun[]>][] = [];
  for (const chaosCase of CHAOS_CASES) {
    const caseDir = join(dir, chaosCase);
    if (!(await exists(caseDir))) continue;
    const results = await loadResults(caseDir);
    const algorithms = new Map<string, ChaosRun[]>();
    for (const [algorithm, runs] of results.algorithms) {
      const chaosRuns: ChaosRun[] = [];
      for (const run of runs) {
        const runDir = join(caseDir, algorithm, `run-${String(run.meta.run)}`);
        const faults = JSON.parse(await readFile(join(runDir, 'faults.json'), 'utf8')) as Fault[];
        const dropped = await droppedIterations(join(runDir, 'k6-summary.json'));
        chaosRuns.push({ ...run, faults, ...(dropped === undefined ? {} : { dropped }) });
      }
      algorithms.set(algorithm, chaosRuns);
    }
    cases.push([chaosCase, { limit: results.limit, windowMs: results.windowMs }, algorithms]);
  }
  if (cases.length === 0) throw new Error(`${dir}: no kill/ or pause/ results`);
  return cases;
}

/** k6's dropped_iterations from --summary-export: 0 when it dropped none, as k6 then omits it. */
async function droppedIterations(file: string): Promise<number | undefined> {
  if (!(await exists(file))) return undefined;
  const summary = JSON.parse(await readFile(file, 'utf8')) as {
    metrics?: Record<string, { count?: number } | undefined>;
  };
  return summary.metrics?.dropped_iterations?.count ?? 0;
}

/** Analyses chaos results and writes summary.md into the results directory. */
export async function analyseChaosDir(dir: string): Promise<string> {
  const tables = (await loadChaosResults(dir)).map(([chaosCase, rule, algorithms]) =>
    chaosTable(
      chaosCase,
      rule,
      [...algorithms].map(([algorithm, runs]) => [algorithm, runs.map(chaosMetrics)] as const),
    ),
  );
  const summary = tables.join('\n');
  await writeFile(join(dir, 'summary.md'), summary);
  return summary;
}

async function isChaosDir(dir: string): Promise<boolean> {
  for (const c of CHAOS_CASES) if (await exists(join(dir, c))) return true;
  return false;
}

async function main(dir: string | undefined): Promise<void> {
  if (dir === undefined) {
    console.error('Usage: npm run bench:analyse -- <results-dir>');
    process.exitCode = 1;
    return;
  }
  if (await isChaosDir(dir)) {
    console.log(await analyseChaosDir(dir));
    console.log(`Wrote summary.md in ${basename(dir)}/`);
    return;
  }
  console.log(await analyseDir(dir));
  console.log(`Wrote summary.md, spread.md and chart.json in ${basename(dir)}/`);
}

// Run only as a script, so tests can import loadResults and analyse without side effects.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main(process.argv[2]);
}
