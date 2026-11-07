// Runs the milestone 3 benchmarks against the stack (docker-compose.yml) and analyses them.
//
//   npm run bench                                    every scenario and algorithm, 3 runs each
//   npm run bench -- --scenario edges --algorithm fixed-window,sliding-window-log --quick
//
// Options:
//   --scenario  steady | ramp | edges | all (default all)
//   --algorithm comma-separated (default: the five, plus none for steady and ramp)
//   --runs      runs per algorithm (default 3, or 1 with --quick)
//   --quick     short scenarios, written to bench/results/ (gitignored) instead of
//               docs/decisions/data/
//   --out       where results directories go
//   --rate      steady's request rate (default 500); the results directory is named for it
//   --decision  the decision record the data is evidence for, which prefixes the results
//               directory (default 0008)
//   --metrics   run the apps with METRICS=1, so every decision goes through prometheusHooks().
//               Nothing scrapes them: this measures the hooks, not Prometheus. Adds -metrics to
//               the results directory's name.
//
// For each run it recreates the whole stack, so every run starts with an empty Redis, then runs
// k6 in Docker on the stack's network. See docs/milestone-3.md and decision 0017.
import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { join, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { createGunzip, gzipSync } from 'node:zlib';
import { parse as parseYaml } from 'yaml';
import { analyseDir } from './analyse.ts';
import type { RunMeta } from './analysis.ts';
import {
  K6Seconds,
  parseCommandStats,
  parseConsoleLog,
  redisCallsBetween,
  resultsDirName,
} from './records.ts';
import { baseSetup, ROOT, sh } from './setup.ts';

const K6_IMAGE = 'grafana/k6:2.3.0';
const APP_IMAGE = 'rate-limiter-bench:stack';
const NETWORK = 'rate-limiter-stack_default';
const LIMITERS = [
  'token-bucket',
  'leaky-bucket',
  'fixed-window',
  'sliding-window-log',
  'sliding-window-counter',
];

interface Scenario {
  readonly rules: string;
  /** A peak per window means nothing without a limiter, so edges leaves `none` out. */
  readonly algorithms: readonly string[];
}

const SCENARIOS: Readonly<Record<string, Scenario>> = {
  steady: { rules: 'steady.yaml', algorithms: ['none', ...LIMITERS] },
  ramp: { rules: 'steady.yaml', algorithms: ['none', ...LIMITERS] },
  edges: { rules: 'edges.yaml', algorithms: LIMITERS },
};

const { values } = parseArgs({
  options: {
    scenario: { type: 'string', default: 'all' },
    algorithm: { type: 'string' },
    runs: { type: 'string' },
    quick: { type: 'boolean', default: false },
    out: { type: 'string' },
    rate: { type: 'string' },
    decision: { type: 'string', default: '0008' },
    metrics: { type: 'boolean', default: false },
  },
});

const scenarioNames = values.scenario === 'all' ? Object.keys(SCENARIOS) : [values.scenario];
for (const name of scenarioNames) {
  if (!(name in SCENARIOS)) {
    throw new Error(
      `Unknown --scenario "${name}". Use ${Object.keys(SCENARIOS).join(', ')} or all.`,
    );
  }
}
const runs = Number(values.runs ?? (values.quick ? 1 : 3));
if (!Number.isInteger(runs) || runs < 1) throw new Error('--runs must be a positive integer');
const rate = values.rate === undefined ? undefined : Number(values.rate);
if (rate !== undefined && (!Number.isInteger(rate) || rate < 1)) {
  throw new Error('--rate must be a positive integer');
}
if (rate !== undefined && scenarioNames.some((n) => n !== 'steady')) {
  throw new Error('--rate applies to steady only: use --scenario steady');
}
if (!/^\d{4}$/.test(values.decision)) throw new Error('--decision must be four digits, e.g. 0009');
const outRoot = resolve(
  values.out ?? (values.quick ? join(ROOT, 'bench/results') : join(ROOT, 'docs/decisions/data')),
);

console.log('Building the app image');
sh('docker', ['compose', '--progress', 'quiet', 'build']);

for (const name of scenarioNames) {
  const scenario = SCENARIOS[name] as Scenario; // checked above
  const algorithms = values.algorithm?.split(',') ?? scenario.algorithms;
  const rule = await readRule(scenario.rules);

  await mkdir(outRoot, { recursive: true });
  const label =
    (rate === undefined ? name : `${name}-${String(rate)}rps`) + (values.metrics ? '-metrics' : '');
  const dir = join(
    outRoot,
    resultsDirName(label, new Date(), await readdir(outRoot), values.decision),
  );
  await mkdir(dir);
  console.log(`\n== ${name} → ${relative(ROOT, dir)}`);

  let setupWritten = false;
  for (const algorithm of algorithms) {
    for (let run = 1; run <= runs; run++) {
      process.stdout.write(`   ${algorithm} run ${String(run)}/${String(runs)} … `);
      startStack(algorithm, scenario.rules);
      // Versions come from the running stack, so write setup once it's up.
      if (!setupWritten) {
        await writeFile(join(dir, 'setup.json'), `${JSON.stringify(setup(), null, 2)}\n`);
        setupWritten = true;
      }
      const runDir = join(dir, algorithm, `run-${String(run)}`);
      await mkdir(runDir, { recursive: true });
      const meta: RunMeta = { algorithm, scenario: name, run, ...rule };
      await writeFile(join(runDir, 'meta.json'), `${JSON.stringify(meta)}\n`);
      const before = commandStats();
      const count = await runK6(name, runDir, rule);
      const calls = redisCallsBetween(before, commandStats());
      await writeFile(join(runDir, 'redis-calls.json'), `${JSON.stringify(calls)}\n`);
      console.log(`${String(count)} requests`);
    }
  }
  console.log(`\n${await analyseDir(dir)}`);
}
console.log('The stack is still running; stop it with npm run stack:down.');

async function readRule(file: string): Promise<{ limit: number; windowMs: number }> {
  const parsed = parseYaml(await readFile(join(ROOT, 'bench/rules', file), 'utf8')) as {
    rules: { limit: number; windowMs: number }[];
  };
  const rule = parsed.rules[0];
  if (parsed.rules.length !== 1 || rule === undefined) {
    throw new Error(`bench/rules/${file}: the benchmarks expect exactly one rule`);
  }
  return { limit: rule.limit, windowMs: rule.windowMs };
}

function startStack(algorithm: string, rules: string): void {
  sh('docker', ['compose', '--progress', 'quiet', 'up', '-d', '--wait', '--force-recreate'], {
    ALGORITHM: algorithm,
    RULES: rules,
    METRICS: values.metrics ? '1' : '0',
  });
}

/**
 * Runs one scenario, then turns k6's console log into requests.jsonl.gz, or for the ramp, k6's
 * JSON output into seconds.jsonl. Returns the request count.
 */
async function runK6(
  scenario: string,
  runDir: string,
  rule: { limit: number; windowMs: number },
): Promise<number> {
  const ramp = scenario === 'ramp';
  const stats = ramp ? sampleDockerStats(join(runDir, 'docker-stats.jsonl')) : undefined;
  // The ramp can't log every request: k6 serialises console output, which capped it near
  // 20,000 req/s, below the stack's knee. Its JSON output kept up, and per-second totals are
  // all the ramp needs. The other scenarios run at 1,000 req/s or less, where logging is free.
  const k6Args = ramp
    ? ['-e', 'LOG=0', K6_IMAGE, 'run', '--quiet', '--out', 'json=/out/k6.json.gz']
    : [K6_IMAGE, 'run', '--quiet', '--console-output=/out/console.log'];
  try {
    const output = await shAsync('docker', [
      'run',
      '--rm',
      // As the current user, so k6 can write into the bind-mounted run directory on Linux too.
      '--user',
      `${String(os.userInfo().uid)}:${String(os.userInfo().gid)}`,
      '--network',
      NETWORK,
      '-v',
      `${join(ROOT, 'bench/k6')}:/scripts:ro`,
      '-v',
      `${runDir}:/out`,
      '-e',
      'BASE_URL=http://lb',
      '-e',
      `QUICK=${values.quick ? '1' : '0'}`,
      '-e',
      `LIMIT=${String(rule.limit)}`,
      '-e',
      `WINDOW_MS=${String(rule.windowMs)}`,
      ...(rate === undefined ? [] : ['-e', `RATE=${String(rate)}`]),
      ...k6Args,
      '--summary-export=/out/k6-summary.json',
      `/scripts/${scenario}.ts`,
    ]);
    await writeFile(join(runDir, 'k6.txt'), output);
  } finally {
    stats?.kill();
  }
  if (ramp) return writeSeconds(runDir);
  const consoleLog = join(runDir, 'console.log');
  const records = parseConsoleLog(await readFile(consoleLog, 'utf8'));
  if (records.length === 0) throw new Error(`${runDir}: k6 logged no requests`);
  // Compressed: raw records run to about 108 bytes each, and gzip shrinks them several times.
  const lines = records.map((r) => JSON.stringify(r)).join('\n') + '\n';
  await writeFile(join(runDir, 'requests.jsonl.gz'), gzipSync(lines));
  // requests.jsonl.gz holds everything the console log did, in a stable form.
  await rm(consoleLog);
  return records.length;
}

/**
 * Streams the ramp's k6.json.gz into seconds.jsonl. A full run's JSON is a few hundred MB
 * compressed, far too big for git, so .gitignore keeps it local and git gets these totals,
 * which give throughput exactly.
 */
async function writeSeconds(runDir: string): Promise<number> {
  const totals = new K6Seconds();
  const lines = createInterface({
    input: createReadStream(join(runDir, 'k6.json.gz')).pipe(createGunzip()),
    crlfDelay: Infinity,
  });
  for await (const line of lines) totals.add(line);
  const seconds = totals.totals();
  const count = seconds.reduce((sum, s) => sum + s.count, 0);
  if (count === 0) throw new Error(`${runDir}: k6 recorded no requests`);
  await writeFile(
    join(runDir, 'seconds.jsonl'),
    seconds.map((x) => JSON.stringify(x)).join('\n') + '\n',
  );
  return count;
}

/** Calls per command so far, from the stack's Redis. */
function commandStats(): Record<string, number> {
  return parseCommandStats(
    sh('docker', ['compose', 'exec', '-T', 'redis', 'redis-cli', 'INFO', 'commandstats']),
  );
}

/** One JSON line per container per second, so a run shows whether nginx's one worker saturated. */
function sampleDockerStats(file: string): { kill(): void } {
  const out = createWriteStream(file);
  const child = spawn('docker', ['stats', '--format', '{{json .}}'], {
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  child.stdout.on('data', (chunk: Buffer) => {
    // docker stats clears the screen between samples; keep only the JSON lines.
    for (const line of chunk.toString().split('\n')) {
      // eslint-disable-next-line no-control-regex -- stripping the terminal's escape codes
      const clean = line.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
      const json = clean.slice(clean.indexOf('{'));
      if (json.startsWith('{') && json.includes('rate-limiter-stack')) {
        // Only what the analysis reads, so a minute of samples stays small enough for git.
        const stats = JSON.parse(json.trim()) as { Name: string; CPUPerc: string };
        const sample = {
          at: Date.now(),
          name: stats.Name.replace(/^rate-limiter-stack-/, '').replace(/-1$/, ''),
          cpu: Number.parseFloat(stats.CPUPerc),
        };
        out.write(`${JSON.stringify(sample)}\n`);
      }
    }
  });
  return {
    kill: () => {
      child.kill();
      out.end();
    },
  };
}

/**
 * Like sh, but doesn't block. k6 runs this way so the event loop stays free to timestamp
 * `docker stats` samples as they arrive: with a blocking call they all queued up until k6 exited,
 * and every sample got the same time.
 */
function shAsync(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'inherit'] });
    const chunks: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolvePromise(Buffer.concat(chunks).toString('utf8'));
      else reject(new Error(`${cmd} ${args.join(' ')} exited with ${String(code)}`));
    });
  });
}

/** Everything needed to rerun or judge the numbers: the shared parts, plus the stack's. */
function setup(): Record<string, unknown> {
  const [dockerCpus, dockerMem] = sh('docker', ['info', '--format', '{{.NCPU}} {{.MemTotal}}'])
    .trim()
    .split(' ');
  return {
    ...baseSetup(`npm run bench -- ${process.argv.slice(2).join(' ')}`.trim()),
    docker: {
      version: sh('docker', ['version', '--format', '{{.Server.Version}}']).trim(),
      cpus: Number(dockerCpus),
      memoryGiB: Math.round(Number(dockerMem) / 2 ** 30),
    },
    versions: {
      node: sh('docker', ['run', '--rm', '--entrypoint', 'node', APP_IMAGE, '-v']).trim(),
      redis: sh('docker', ['compose', 'exec', '-T', 'redis', 'redis-server', '--version']).trim(),
      // nginx prints its version on stderr.
      nginx: sh('docker', ['compose', 'exec', '-T', 'lb', 'sh', '-c', 'nginx -v 2>&1']).trim(),
      k6: sh('docker', ['run', '--rm', K6_IMAGE, 'version']).trim(),
    },
    stack: { instances: 3, nginxWorkers: 1, metrics: values.metrics },
  };
}
