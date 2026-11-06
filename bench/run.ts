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
//
// For each run it recreates the whole stack, so every run starts with an empty Redis, then runs
// k6 in Docker on the stack's network. See docs/milestone-3.md and decision 0017.
import { execFileSync, spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { parse as parseYaml } from 'yaml';
import { analyseDir } from './analyse.ts';
import type { RunMeta } from './analysis.ts';
import { parseConsoleLog, resultsDirName } from './records.ts';

const ROOT = resolve(import.meta.dirname, '..');
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
  const dir = join(outRoot, resultsDirName(name, new Date(), await readdir(outRoot)));
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
      const count = await runK6(name, runDir, rule);
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
  });
}

/** Runs one scenario, then turns k6's console log into requests.jsonl. Returns the record count. */
async function runK6(
  scenario: string,
  runDir: string,
  rule: { limit: number; windowMs: number },
): Promise<number> {
  const stats =
    scenario === 'ramp' ? sampleDockerStats(join(runDir, 'docker-stats.jsonl')) : undefined;
  try {
    const output = sh('docker', [
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
      K6_IMAGE,
      'run',
      '--quiet',
      '--console-output=/out/console.log',
      '--summary-export=/out/k6-summary.json',
      `/scripts/${scenario}.ts`,
    ]);
    await writeFile(join(runDir, 'k6.txt'), output);
  } finally {
    stats?.kill();
  }
  const consoleLog = join(runDir, 'console.log');
  const records = parseConsoleLog(await readFile(consoleLog, 'utf8'));
  if (records.length === 0) throw new Error(`${runDir}: k6 logged no requests`);
  await writeFile(
    join(runDir, 'requests.jsonl'),
    records.map((r) => JSON.stringify(r)).join('\n') + '\n',
  );
  // requests.jsonl holds everything the console log did, in a stable form.
  await rm(consoleLog);
  return records.length;
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
        out.write(`{"at":${String(Date.now())},"stats":${json.trim()}}\n`);
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

/** Everything needed to rerun or judge the numbers. Leaves out the hostname, which can identify you. */
function setup(): Record<string, unknown> {
  const cpus = os.cpus();
  const [dockerCpus, dockerMem] = sh('docker', ['info', '--format', '{{.NCPU}} {{.MemTotal}}'])
    .trim()
    .split(' ');
  return {
    date: new Date().toISOString(),
    command: `npm run bench -- ${process.argv.slice(2).join(' ')}`.trim(),
    git: {
      commit: sh('git', ['rev-parse', 'HEAD']).trim(),
      uncommittedChanges: sh('git', ['status', '--porcelain']).trim() !== '',
    },
    host: {
      os: `${os.type()} ${os.release()} ${os.arch()}`,
      cpu: cpus[0]?.model ?? 'unknown',
      cores: cpus.length,
      memoryGiB: Math.round(os.totalmem() / 2 ** 30),
    },
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
    stack: { instances: 3, nginxWorkers: 1 },
  };
}

/** Runs a command from the repo root and returns its stdout. Its stderr goes to the terminal. */
function sh(cmd: string, args: string[], env: Record<string, string> = {}): string {
  return execFileSync(cmd, args, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    maxBuffer: 256 * 1024 * 1024,
  });
}
