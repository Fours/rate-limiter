// Reads the write-up's chart data from docs/decisions/data/ when the demo builds, so the charts
// can't drift from the numbers the decision records quote. It reads the committed summaries,
// not the raw runs: some raw records are too big for git (0009's and 0005's at 15,000 req/s),
// so the summaries are the only committed copy of those numbers. A missing file, table, row or
// column throws, naming it, which fails the build (spec T7).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  AlgorithmName,
  BaselineRow,
  BenchAlgorithm,
  ChaosRow,
  EdgesRow,
  EdgesSeries,
  LatencyRow,
  MemoryRow,
  RampRow,
  WriteupData,
} from '../src/writeup/data.ts';

export const DATA_DIR = fileURLToPath(new URL('../../docs/decisions/data/', import.meta.url));

/** Every file the write-up reads, relative to the data directory. */
export const SOURCES = {
  steady: '0008-steady-2026-11-06/summary.md',
  edges: '0008-edges-2026-11-07/summary.md',
  edgesChart: '0008-edges-2026-11-07/chart.json',
  ramp: '0008-ramp-2026-11-07/summary.md',
  memory: '0008-memory-2026-11-06/memory.json',
  chaos: '0010-chaos-2026-11-07/summary.md',
  baseline500: '0009-steady-500rps-2026-11-07/summary.md',
  baseline15000: '0009-steady-15000rps-2026-11-07/summary.md',
  metricsWithout: '0005-steady-15000rps-2026-11-07/summary.md',
  metricsWith: '0005-steady-15000rps-metrics-2026-11-07/summary.md',
} as const;

const ALGORITHMS: readonly AlgorithmName[] = [
  'token-bucket',
  'leaky-bucket',
  'fixed-window',
  'sliding-window-log',
  'sliding-window-counter',
];

export function loadWriteupData(dir: string = DATA_DIR): WriteupData {
  const read = (source: string) => {
    const path = join(dir, source);
    if (!existsSync(path)) throw new Error(`The write-up's data is missing ${path}`);
    return { path, text: readFileSync(path, 'utf8') };
  };
  const doc = (source: string) => {
    const { path, text } = read(source);
    return parseSummary(text, path);
  };

  const steady = doc(SOURCES.steady).section('steady');
  const edges = doc(SOURCES.edges).section('edges');
  const ramp = doc(SOURCES.ramp).section('ramp');
  const chaos = doc(SOURCES.chaos);
  const killed = chaos.section('chaos: Redis killed');
  const paused = chaos.section('chaos: Redis paused');

  const cpu = ramp.table('CPU at the peak second');
  return {
    steady: { limit: steady.rule.limit, rows: steady.table().rows.map(latencyRow) },
    edges: {
      limit: edges.rule.limit,
      windowMs: edges.rule.windowMs,
      rows: edges.table().rows.map((r): EdgesRow => ({
        algorithm: algorithm(r.get('Algorithm')),
        peak: lead(r.get('Peak per window')),
        falseDenials: percent(r.get('False denials')),
      })),
      series: edgesSeries(read(SOURCES.edgesChart)),
    },
    ramp: ramp.table().rows.map((r): RampRow => ({
      algorithm: benchAlgorithm(r.get('Algorithm')),
      throughput: lead(r.get('Throughput (req/s)')),
      redisCpu: lead(cpu.row(r.get('Algorithm')).get('redis')),
    })),
    memory: memoryRows(read(SOURCES.memory)),
    chaos: {
      limit: killed.rule.limit,
      killed: chaosRows(killed),
      paused: chaosRows(paused),
    },
    baseline: (
      [
        [500, SOURCES.baseline500],
        [15_000, SOURCES.baseline15000],
      ] as const
    ).map(([rate, source]): BaselineRow => {
      const s = doc(source).section('steady');
      const latency = s.table().row('token-bucket');
      const redis = s.table('Redis operations').row('token-bucket');
      return {
        rate,
        limiterP50: lead(latency.get('Limiter p50 (ms)')),
        limiterP99: lead(latency.get('Limiter p99 (ms)')),
        roundTripsPerRequest: lead(redis.get('Round trips per request')),
      };
    }),
    metrics: {
      without: latencyRow(
        doc(SOURCES.metricsWithout).section('steady').table().row('sliding-window-counter'),
      ),
      with: latencyRow(
        doc(SOURCES.metricsWith).section('steady').table().row('sliding-window-counter'),
      ),
    },
  };
}

// ---------- The summaries' Markdown, as bench/analyse.ts writes it ----------

interface Row {
  get(column: string): string;
}

interface Table {
  readonly rows: readonly Row[];
  row(first: string): Row;
}

interface Section {
  readonly rule: { readonly limit: number; readonly windowMs: number };
  /** The section's first table, or the one under a `###` heading. */
  table(heading?: string): Table;
}

interface Summary {
  section(heading: string): Section;
}

export function parseSummary(text: string, path: string): Summary {
  const sections = new Map<string, string[]>();
  let current: string[] | undefined;
  for (const line of text.split('\n')) {
    const h2 = /^## (.+)$/.exec(line);
    if (h2?.[1] !== undefined) {
      current = [];
      sections.set(h2[1].trim(), current);
    } else {
      current?.push(line);
    }
  }
  return {
    section(heading) {
      const lines = sections.get(heading);
      if (lines === undefined) throw new Error(`${path} has no "## ${heading}" section`);
      return parseSection(lines, `${path}, "## ${heading}"`);
    },
  };
}

function parseSection(lines: readonly string[], where: string): Section {
  const ruleMatch = /^Rule: (\d+) per (\d+) ms/.exec(
    lines.find((l) => l.startsWith('Rule:')) ?? '',
  );
  const tables = new Map<string, Table>();
  let heading = '';
  let block: string[] = [];
  const flush = () => {
    if (block.length > 0 && !tables.has(heading)) tables.set(heading, parseTable(block, where));
    block = [];
  };
  for (const line of lines) {
    const h3 = /^### (.+)$/.exec(line);
    if (h3?.[1] !== undefined) {
      flush();
      heading = h3[1].trim();
    } else if (line.startsWith('|')) {
      block.push(line);
    } else {
      flush();
    }
  }
  flush();
  return {
    get rule() {
      if (ruleMatch?.[1] === undefined || ruleMatch[2] === undefined) {
        throw new Error(`${where} has no "Rule: N per M ms" line`);
      }
      return { limit: Number(ruleMatch[1]), windowMs: Number(ruleMatch[2]) };
    },
    table(name = '') {
      const table = tables.get(name);
      if (table === undefined) {
        throw new Error(`${where} has no table${name === '' ? '' : ` under "### ${name}"`}`);
      }
      return table;
    },
  };
}

const cells = (line: string) =>
  line
    .slice(1, line.endsWith('|') ? -1 : undefined)
    .split('|')
    .map((c) => c.trim().replace(/^\*\*(.*)\*\*$/, '$1'));

function parseTable(lines: readonly string[], where: string): Table {
  const [header, , ...body] = lines;
  if (header === undefined) throw new Error(`${where} has an empty table`);
  const columns = cells(header);
  const rows = body.map((line) => {
    const values = cells(line);
    return {
      first: values[0] ?? '',
      get(column: string) {
        const i = columns.indexOf(column);
        const value = values[i];
        if (i < 0 || value === undefined) throw new Error(`${where} has no "${column}" column`);
        return value;
      },
    };
  });
  return {
    // Chaos tables list each run under its algorithm's median: the medians are what's charted.
    rows: rows.filter((r) => !/^run \d+$/.test(r.first)),
    row(first) {
      const row = rows.find((r) => r.first === first);
      if (row === undefined) throw new Error(`${where} has no "${first}" row`);
      return row;
    },
  };
}

// ---------- Cells ----------

/** The number a cell starts with: `1,050`, `154 (1.54× limit)`, `78%`. */
export function lead(cell: string): number {
  const match = /^-?[\d,]+(?:\.\d+)?/.exec(cell);
  if (match === null) throw new Error(`"${cell}" isn't a number`);
  return Number(match[0].replace(/,/g, ''));
}

/** `14.6%` as 0.146. */
export function percent(cell: string): number {
  return lead(cell) / 100;
}

/** A number, or null for the summaries' dash. */
const maybe = (cell: string) => (cell === '–' ? null : lead(cell));

function benchAlgorithm(cell: string): BenchAlgorithm {
  return cell === 'none' ? 'none' : algorithm(cell);
}

function algorithm(cell: string): AlgorithmName {
  const found = ALGORITHMS.find((a) => a === cell);
  if (found === undefined) throw new Error(`"${cell}" isn't one of the five algorithms`);
  return found;
}

function latencyRow(r: Row): LatencyRow {
  return {
    algorithm: benchAlgorithm(r.get('Algorithm')),
    limiterP50: maybe(r.get('Limiter p50 (ms)')),
    limiterP99: maybe(r.get('Limiter p99 (ms)')),
    e2eP50: lead(r.get('End-to-end p50 (ms)')),
    e2eP99: lead(r.get('End-to-end p99 (ms)')),
  };
}

function chaosRows(section: Section): ChaosRow[] {
  return section.table().rows.map((r) => {
    const p99 = r
      .get('End-to-end p99 (ms)')
      .split('/')
      .map((c) => lead(c.trim()));
    const [before, during, after] = p99;
    if (p99.length !== 3 || before === undefined || during === undefined || after === undefined) {
      throw new Error(`"${r.get('End-to-end p99 (ms)')}" isn't before / during / after`);
    }
    return {
      algorithm: algorithm(r.get('Algorithm')),
      failed: lead(r.get('Failed requests')),
      p99: [before, during, after],
      fallbackShare: percent(r.get('Fallback share, outage')),
      peakGoing: lead(r.get('Peak, going away')),
      peakComing: lead(r.get('Peak, coming back')),
      recoveryMs: lead(r.get('Recovery (ms)')),
    };
  });
}

// ---------- JSON ----------

function parseJson(file: { path: string; text: string }): unknown {
  try {
    return JSON.parse(file.text);
  } catch (err) {
    throw new Error(`${file.path} isn't valid JSON`, { cause: err });
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function memoryRows(file: { path: string; text: string }): MemoryRow[] {
  const json = parseJson(file);
  if (!Array.isArray(json)) throw new Error(`${file.path} isn't a list of rows`);
  return json.map((row: unknown) => {
    if (
      !isRecord(row) ||
      typeof row.algorithm !== 'string' ||
      typeof row.limit !== 'number' ||
      typeof row.bytes !== 'number' ||
      typeof row.encoding !== 'string'
    ) {
      throw new Error(`${file.path} has a row without algorithm, limit, bytes and encoding`);
    }
    return {
      algorithm: algorithm(row.algorithm),
      limit: row.limit,
      bytes: row.bytes,
      encoding: row.encoding,
    };
  });
}

function edgesSeries(file: { path: string; text: string }): EdgesSeries[] {
  const json = parseJson(file);
  if (!isRecord(json) || !Array.isArray(json.algorithms)) {
    throw new Error(`${file.path} has no algorithms`);
  }
  return json.algorithms.map((entry: unknown) => {
    if (!isRecord(entry) || typeof entry.algorithm !== 'string' || !Array.isArray(entry.series)) {
      throw new Error(`${file.path} has an algorithm without a series`);
    }
    return {
      algorithm: algorithm(entry.algorithm),
      points: entry.series.map((p: unknown): [number, number] => {
        if (!isRecord(p) || typeof p.t !== 'number' || typeof p.allowed !== 'number') {
          throw new Error(`${file.path} has a point without t and allowed`);
        }
        return [p.t, p.allowed];
      }),
    };
  });
}
