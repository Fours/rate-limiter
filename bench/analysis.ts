// How the milestone 3 benchmarks turn raw records into numbers (decision 0017). Pure functions,
// no I/O: bench/analyse.ts reads and writes files. Written in T2, before any real data existed,
// so the method was fixed before the numbers were seen.

/** One request, in the format every scenario writes, whatever produced it (k6 or app logs). */
export interface RequestRecord {
  /** Who sent it: the `x-api-key` the scenario used. */
  readonly client: string;
  /**
   * When it reached the app, epoch ms (X-Received-At), which windows are timed by. Falls back to
   * the send time for a request that got no response.
   */
  readonly t: number;
  /** When the load generator sent it, by its own clock, epoch ms. Kept for comparison only. */
  readonly sentAt?: number;
  readonly status: number;
  /** End-to-end time, as the load generator saw it, ms. */
  readonly e2eMs: number;
  /** The limiter's own time from `Server-Timing`, ms. Absent with ALGORITHM=none. */
  readonly limiterMs?: number;
  /** The app instance that answered (X-Instance). Recorded since milestone 4. */
  readonly instance?: string;
  /** Which source decided (X-RateLimit-Source). Absent when nothing was limited. */
  readonly source?: 'primary' | 'fallback';
}

export interface RunMeta {
  readonly algorithm: string;
  readonly scenario: string;
  readonly run: number;
  /** The rule every request ran against. */
  readonly limit: number;
  readonly windowMs: number;
}

export interface Run {
  readonly meta: RunMeta;
  /** Empty when only per-second totals were kept (the ramp, whose raw records are too big for git). */
  readonly records: readonly RequestRecord[];
  /** Per-second totals. When present, they're used instead of the records. */
  readonly seconds?: readonly SecondTotals[];
  /** `docker stats` samples taken during the run, if any (the ramp). */
  readonly cpu?: readonly CpuSample[];
  /** The limiter's Redis calls during the run, per command (bench/records.ts), if recorded. */
  readonly redisCalls?: Readonly<Record<string, number>>;
}

/**
 * One second of traffic: everything throughput needs, in a form small enough for git. Seconds
 * from records are by `t`. The ramp's come from k6's JSON output, by when each response arrived
 * (bench/records.ts, `K6Seconds`).
 */
export interface SecondTotals {
  /** floor(t / 1000), or of the arrival time */
  readonly second: number;
  readonly count: number;
  /** Every response was a 200 or a 429. */
  readonly healthy: boolean;
  /** p99 end-to-end time in that second, ms */
  readonly p99: number;
  /**
   * Requests k6 should have started that second but couldn't (its `dropped_iterations`), because
   * it was short of VUs or CPU. Absent means none were recorded.
   */
  readonly dropped?: number;
}

export interface CpuSample {
  /** epoch ms, by the host's clock */
  readonly at: number;
  /** container name without the stack prefix, e.g. app-1 */
  readonly name: string;
  /** % of one core, so a busy single-threaded process tops out near 100 */
  readonly cpu: number;
}

/** "Sustained" means p99 under this, with no errors. It's milestone 4's timeout (0010). */
export const SLO_MS = 50;

/**
 * How finely the records can place a request against the limiter's own clock, in ms. Redis
 * `TIME` is truncated to whole ms, so two requests a sliding window log correctly allows exactly
 * one window apart can be up to 1 ms less than a window apart in real time. The records' `t` is
 * also taken in the app, a fraction of a ms before Redis decides. So window comparisons give
 * this much benefit of the doubt: spans for the peak are this much shorter, and trailing windows
 * for false denials this much longer.
 *
 * Added in T3, after the first quick runs: the log showed 101 against a limit of 100 in 10
 * spans, each between 9,999.5 and 9,999.99 ms long for a 10,000 ms window (decision 0017).
 */
export const RESOLUTION_MS = 2;

const ALLOWED = 200;
const DENIED = 429;

/**
 * The most timestamps in any span `[s, s + windowMs)`. Half-open, like the sliding window log's
 * own window `(now − W, now]`: two requests exactly `windowMs` apart are never in one window.
 * The busiest span can always be slid right until it starts at a request, so only spans that
 * start at a request need checking. That's a two-pointer pass, not a scan over every start time.
 */
export function maxInWindow(times: readonly number[], windowMs: number): number {
  const sorted = [...times].sort((a, b) => a - b);
  let best = 0;
  let left = 0;
  sorted.forEach((t, right) => {
    while (t - (sorted[left] ?? t) >= windowMs) left++;
    best = Math.max(best, right - left + 1);
  });
  return best;
}

export interface Peak {
  /** Most requests allowed for one client in any span of `windowMs − RESOLUTION_MS`. */
  readonly peak: number;
  /** That client, or undefined when nothing was allowed. */
  readonly client: string | undefined;
}

export function peakPerWindow(records: readonly RequestRecord[], windowMs: number): Peak {
  let best: Peak = { peak: 0, client: undefined };
  for (const [client, own] of byClient(records)) {
    const peak = maxInWindow(
      own.filter((r) => r.status === ALLOWED).map((r) => r.t),
      windowMs - RESOLUTION_MS,
    );
    if (peak > best.peak) best = { peak, client };
  }
  return best;
}

/**
 * Denials an exact sliding window would have allowed: a 429 when fewer than `limit` requests
 * were allowed for that client in the trailing window `(t − windowMs − RESOLUTION_MS, t]`. The sliding window
 * log should score 0. The token and leaky buckets score high by design, since they refill
 * gradually or allow no burst: this measures distance from the exact ideal, not a bug.
 */
export function falseDenials(
  records: readonly RequestRecord[],
  rule: Pick<RunMeta, 'limit' | 'windowMs'>,
): number {
  let count = 0;
  for (const own of byClient(records).values()) {
    const allowed: number[] = [];
    let oldest = 0;
    // Stable sort: requests in the same millisecond keep the order they were recorded in.
    for (const r of [...own].sort((a, b) => a.t - b.t)) {
      while (
        oldest < allowed.length &&
        (allowed[oldest] ?? 0) <= r.t - rule.windowMs - RESOLUTION_MS
      )
        oldest++;
      const inWindow = allowed.length - oldest;
      if (r.status === DENIED && inWindow < rule.limit) count++;
      if (r.status === ALLOWED) allowed.push(r.t);
    }
  }
  return count;
}

/**
 * Nearest rank: the `ceil(p/100 × n)`-th smallest sample. It always returns a real sample and
 * needs no interpolation, so a p99 is a latency some request actually saw.
 */
export function percentile(samples: readonly number[], p: number): number {
  if (samples.length === 0) throw new RangeError('percentile of no samples');
  if (!(p > 0 && p <= 100))
    throw new RangeError(`percentile must be in (0, 100], got ${String(p)}`);
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[rank - 1] as number; // 1 <= rank <= length, so always defined
}

/** The middle value; for an even count, the mean of the middle two. */
export function median(values: readonly number[]): number {
  if (values.length === 0) throw new RangeError('median of no values');
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const upper = sorted[mid] as number;
  return sorted.length % 2 === 1 ? upper : ((sorted[mid - 1] as number) + upper) / 2;
}

/** Groups records into whole seconds of `t`, in order. */
export function secondsOf(records: readonly RequestRecord[]): SecondTotals[] {
  const buckets = new Map<number, RequestRecord[]>();
  for (const r of records) {
    const second = Math.floor(r.t / 1000);
    const bucket = buckets.get(second);
    if (bucket === undefined) buckets.set(second, [r]);
    else bucket.push(r);
  }
  return [...buckets]
    .sort(([a], [b]) => a - b)
    .map(([second, bucket]) => ({
      second,
      count: bucket.length,
      healthy: bucket.every((r) => r.status === ALLOWED || r.status === DENIED),
      p99: percentile(
        bucket.map((r) => r.e2eMs),
        99,
      ),
    }));
}

/**
 * The second the system sustained the most requests: the busiest whole second whose p99
 * end-to-end time was under SLO_MS, whose responses were all 200 or 429, and in which k6 dropped
 * nothing. A 429 is the limiter working, not an error. A second with drops is the load generator
 * falling behind, so it can't show what the stack sustained. Undefined if no second qualifies.
 *
 * The drop rule was added in T5: the first full ramp logged every request to k6's console, which
 * capped k6 near 20,000 req/s while the stack sat at half a core (decision 0017).
 */
export function peakSecond(
  seconds: readonly SecondTotals[],
  sloMs = SLO_MS,
): SecondTotals | undefined {
  let best: SecondTotals | undefined;
  for (const s of seconds) {
    if (s.healthy && s.p99 < sloMs && (s.dropped ?? 0) === 0 && s.count > (best?.count ?? 0)) {
      best = s;
    }
  }
  return best;
}

/** Requests per second the system sustained: the count in `peakSecond`, or 0. */
export function throughput(records: readonly RequestRecord[], sloMs = SLO_MS): number {
  return peakSecond(secondsOf(records), sloMs)?.count ?? 0;
}

/** Undefined where a run has no data for it: no limiter (none), or only per-second totals (ramp). */
export interface RunMetrics {
  readonly requests: number;
  readonly limiterP50: number | undefined;
  readonly limiterP99: number | undefined;
  readonly e2eP50: number | undefined;
  readonly e2eP99: number | undefined;
  readonly throughputRps: number;
  readonly peakPerWindow: number | undefined;
  /** Share of all requests, 0 to 1. */
  readonly falseDenialRate: number | undefined;
}

export function runMetrics(run: Run): RunMetrics {
  const { records, meta, seconds } = run;
  if (seconds !== undefined) {
    // Per-second totals give throughput exactly, and nothing else.
    return {
      requests: seconds.reduce((sum, s) => sum + s.count, 0),
      limiterP50: undefined,
      limiterP99: undefined,
      e2eP50: undefined,
      e2eP99: undefined,
      throughputRps: peakSecond(seconds)?.count ?? 0,
      peakPerWindow: undefined,
      falseDenialRate: undefined,
    };
  }
  if (records.length === 0) {
    throw new RangeError(`${meta.algorithm} run ${String(meta.run)} has no records`);
  }
  const limiter = records.flatMap((r) => (r.limiterMs === undefined ? [] : [r.limiterMs]));
  const e2e = records.map((r) => r.e2eMs);
  return {
    requests: records.length,
    limiterP50: limiter.length > 0 ? percentile(limiter, 50) : undefined,
    limiterP99: limiter.length > 0 ? percentile(limiter, 99) : undefined,
    e2eP50: percentile(e2e, 50),
    e2eP99: percentile(e2e, 99),
    throughputRps: throughput(records),
    peakPerWindow: peakPerWindow(records, meta.windowMs).peak,
    falseDenialRate: falseDenials(records, meta) / records.length,
  };
}

export type AlgorithmSummary = {
  readonly algorithm: string;
  readonly runs: number;
} & { readonly [K in keyof RunMetrics]: RunMetrics[K] };

/** Each metric is the median across runs, taken separately, so each cell is a real middle value. */
export function summariseRuns(algorithm: string, metrics: readonly RunMetrics[]): AlgorithmSummary {
  if (metrics.length === 0) throw new RangeError(`${algorithm} has no runs`);
  const mid = (pick: (m: RunMetrics) => number) => median(metrics.map(pick));
  const midOptional = (pick: (m: RunMetrics) => number | undefined) => {
    const values = metrics.flatMap((m) => {
      const v = pick(m);
      return v === undefined ? [] : [v];
    });
    return values.length > 0 ? median(values) : undefined;
  };
  return {
    algorithm,
    runs: metrics.length,
    requests: mid((m) => m.requests),
    limiterP50: midOptional((m) => m.limiterP50),
    limiterP99: midOptional((m) => m.limiterP99),
    e2eP50: midOptional((m) => m.e2eP50),
    e2eP99: midOptional((m) => m.e2eP99),
    throughputRps: mid((m) => m.throughputRps),
    peakPerWindow: midOptional((m) => m.peakPerWindow),
    falseDenialRate: midOptional((m) => m.falseDenialRate),
  };
}

/** Rows in this order, so tables from different scenarios line up. Unknown names go last. */
const ORDER = [
  'none',
  'token-bucket',
  'leaky-bucket',
  'fixed-window',
  'sliding-window-log',
  'sliding-window-counter',
];

export function byAlgorithmOrder(a: string, b: string): number {
  const rank = (name: string) => {
    const i = ORDER.indexOf(name);
    return i === -1 ? ORDER.length : i;
  };
  return rank(a) - rank(b) || a.localeCompare(b);
}

export interface Rule {
  readonly limit: number;
  readonly windowMs: number;
}

export function summaryTable(
  scenario: string,
  rule: Rule,
  rows: readonly AlgorithmSummary[],
): string {
  const sorted = [...rows].sort((a, b) => byAlgorithmOrder(a.algorithm, b.algorithm));
  const runs = [...new Set(sorted.map((r) => r.runs))].join(' or ');
  const lines = [
    `## ${scenario}`,
    '',
    `Rule: ${String(rule.limit)} per ${String(rule.windowMs)} ms per client. Each cell is the median of ${runs} runs. Method: [0017](../../0017-how-the-benchmarks-measure.md).`,
    '',
    '| Algorithm | Limiter p50 (ms) | Limiter p99 (ms) | End-to-end p50 (ms) | End-to-end p99 (ms) | Throughput (req/s) | Peak per window | False denials |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...sorted
      .map((r) =>
        [
          r.algorithm,
          ms(r.limiterP50),
          ms(r.limiterP99),
          ms(r.e2eP50),
          ms(r.e2eP99),
          String(Math.round(r.throughputRps)),
          r.peakPerWindow === undefined
            ? '–'
            : `${String(r.peakPerWindow)} (${(r.peakPerWindow / rule.limit).toFixed(2)}× limit)`,
          pct(r.falseDenialRate),
        ].join(' | '),
      )
      .map((row) => `| ${row} |`),
    '',
  ];
  return lines.join('\n');
}

const ms = (v: number | undefined) => (v === undefined ? '–' : v.toFixed(2));
const pct = (v: number | undefined) => (v === undefined ? '–' : `${(v * 100).toFixed(1)}%`);

/**
 * The lowest and highest value of each metric across an algorithm's runs. If these ranges are
 * as wide as the differences between algorithms, three runs aren't enough (decision 0017).
 */
export function spreadTable(
  scenario: string,
  runsByAlgorithm: readonly (readonly [string, readonly RunMetrics[]])[],
): string {
  const range = (values: (number | undefined)[], format: (v: number) => string) => {
    const known = values.filter((v): v is number => v !== undefined);
    return known.length === 0 ? '–' : `${format(Math.min(...known))}–${format(Math.max(...known))}`;
  };
  const sorted = [...runsByAlgorithm].sort(([a], [b]) => byAlgorithmOrder(a, b));
  return [
    `## ${scenario}: spread across runs`,
    '',
    'Lowest–highest value of each metric across the runs that the summary takes the median of.',
    '',
    '| Algorithm | Runs | Limiter p99 (ms) | End-to-end p99 (ms) | Throughput (req/s) | Peak per window | False denials |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...sorted.map(([algorithm, metrics]) =>
      [
        `| ${algorithm}`,
        String(metrics.length),
        range(
          metrics.map((m) => m.limiterP99),
          (v) => v.toFixed(2),
        ),
        range(
          metrics.map((m) => m.e2eP99),
          (v) => v.toFixed(2),
        ),
        range(
          metrics.map((m) => m.throughputRps),
          (v) => String(Math.round(v)),
        ),
        range(
          metrics.map((m) => m.peakPerWindow),
          String,
        ),
        `${range(
          metrics.map((m) => m.falseDenialRate),
          (v) => pct(v),
        )} |`,
      ].join(' | '),
    ),
    '',
  ].join('\n');
}

/**
 * Each container's highest CPU within a second either side of the run's peak second: what was
 * close to its limit when throughput topped out.
 */
export function cpuAtPeak(run: Run): Map<string, number> | undefined {
  const seconds = run.seconds ?? secondsOf(run.records);
  const peak = peakSecond(seconds);
  if (peak === undefined || run.cpu === undefined) return undefined;
  const from = (peak.second - 1) * 1000;
  const to = (peak.second + 2) * 1000;
  const out = new Map<string, number>();
  for (const s of run.cpu) {
    if (s.at >= from && s.at < to) out.set(s.name, Math.max(out.get(s.name) ?? 0, s.cpu));
  }
  return out;
}

/** Median CPU at the peak second, per algorithm and container, as a Markdown table. */
export function cpuTable(runsByAlgorithm: readonly (readonly [string, readonly Run[]])[]): string {
  const rows = [...runsByAlgorithm]
    .sort(([a], [b]) => byAlgorithmOrder(a, b))
    .map(
      ([algorithm, runs]) =>
        [algorithm, runs.map(cpuAtPeak).filter((c) => c !== undefined)] as const,
    )
    .filter(([, cpus]) => cpus.length > 0);
  if (rows.length === 0) return '';
  const names = [...new Set(rows.flatMap(([, cpus]) => cpus.flatMap((c) => [...c.keys()])))].sort();
  return [
    '### CPU at the peak second',
    '',
    "Each container's highest CPU within a second either side of the busiest healthy second, as % of one core, median of runs. A single-threaded process tops out near 100%.",
    '',
    `| Algorithm | ${names.join(' | ')} |`,
    `| --- | ${names.map(() => '---').join(' | ')} |`,
    ...rows.map(([algorithm, cpus]) => {
      const cells = names.map((n) => {
        const values = cpus.flatMap((c) => {
          const v = c.get(n);
          return v === undefined ? [] : [v];
        });
        return values.length === 0 ? '–' : `${median(values).toFixed(0)}%`;
      });
      return `| ${algorithm} | ${cells.join(' | ')} |`;
    }),
    '',
  ].join('\n');
}

/**
 * Commands that are a round trip from the app. `INFO commandstats` also counts the commands a Lua
 * script runs inside Redis (HGET, HSET, TIME…), which cost Redis CPU but no network trip.
 */
const ROUND_TRIP = /^(eval|evalsha|eval_ro|evalsha_ro|script\|.*)$/;

export interface RedisOps {
  /** Round trips from the app per HTTP request: 1 for every algorithm today, about 1/b with batches. */
  readonly roundTripsPerRequest: number;
  /** Round trips per second of traffic, from the first request to the last. */
  readonly roundTripsPerSecond: number;
  /** Every command Redis ran per HTTP request, those inside scripts included. */
  readonly commandsPerRequest: number;
}

/**
 * How hard the limiter worked Redis in one run, or undefined if the run didn't record it. The
 * evidence for 0009: pre-fetching b tokens at a time would cut calls per request to about 1/b.
 */
export function redisOps(run: Run): RedisOps | undefined {
  if (run.redisCalls === undefined) return undefined;
  const entries = Object.entries(run.redisCalls);
  const commands = entries.reduce((sum, [, n]) => sum + n, 0);
  const trips = entries.reduce((sum, [c, n]) => sum + (ROUND_TRIP.test(c) ? n : 0), 0);
  let requests: number;
  let seconds: number;
  if (run.seconds !== undefined && run.seconds.length > 0) {
    requests = run.seconds.reduce((sum, s) => sum + s.count, 0);
    seconds = run.seconds.length;
  } else {
    if (run.records.length === 0) return undefined;
    // A loop, not Math.max(...times): a 15,000 req/s run overflows the call stack with spread.
    let first = Infinity;
    let last = -Infinity;
    for (const r of run.records) {
      first = Math.min(first, r.t);
      last = Math.max(last, r.t);
    }
    requests = run.records.length;
    seconds = (last - first) / 1000;
  }
  if (seconds <= 0) return undefined;
  return {
    roundTripsPerRequest: trips / requests,
    roundTripsPerSecond: trips / seconds,
    commandsPerRequest: commands / requests,
  };
}

/** Median Redis round trips and commands, by algorithm, as a Markdown table. */
export function redisTable(
  runsByAlgorithm: readonly (readonly [string, readonly Run[]])[],
): string {
  const rows = [...runsByAlgorithm]
    .sort(([a], [b]) => byAlgorithmOrder(a, b))
    .map(([algorithm, runs]) => {
      const ops = runs.map(redisOps).filter((o) => o !== undefined);
      const commands = [...new Set(runs.flatMap((r) => Object.keys(r.redisCalls ?? {})))].sort();
      return { algorithm, ops, commands };
    })
    .filter((r) => r.ops.length > 0);
  if (rows.length === 0) return '';
  return [
    '### Redis operations',
    '',
    "From `INFO commandstats` before and after each run, leaving out the healthcheck's `PING` and the runner's own `INFO`. A round trip is an `EVAL` or `EVALSHA` from an app; commands per request also counts what the scripts run inside Redis. Median of runs.",
    '',
    '| Algorithm | Round trips per request | Round trips per second | Commands per request | Commands |',
    '| --- | --- | --- | --- | --- |',
    ...rows.map(({ algorithm, ops, commands }) => {
      const mid = (f: (o: RedisOps) => number) => median(ops.map(f));
      const list = commands.length === 0 ? '–' : commands.map((c) => `\`${c}\``).join(', ');
      return `| ${algorithm} | ${mid((o) => o.roundTripsPerRequest).toFixed(3)} | ${Math.round(mid((o) => o.roundTripsPerSecond)).toLocaleString('en-US')} | ${mid((o) => o.commandsPerRequest).toFixed(2)} | ${list} |`;
    }),
    '',
  ].join('\n');
}

export interface ChartPoint {
  /** ms since the client's first request */
  readonly t: number;
  /** allowed in the trailing span `(t − windowMs + RESOLUTION_MS, t]`, this request included */
  readonly allowed: number;
}

export interface AlgorithmChart {
  readonly algorithm: string;
  /** Which run the series comes from: the one with the median peak. */
  readonly run: number;
  readonly peakPerWindow: number;
  readonly client: string | undefined;
  readonly series: readonly ChartPoint[];
}

/**
 * For the run with the median peak, the busiest client's allowed requests over time: how many
 * were allowed in the trailing window at each one. A fixed window's 2× burst shows as a spike.
 */
export function chartFor(runs: readonly Run[]): AlgorithmChart {
  const peaks = runs.map((run) => ({ run, ...peakPerWindow(run.records, run.meta.windowMs) }));
  const target = median(peaks.map((p) => p.peak));
  // With three runs the median is one of them; nearest covers an even count.
  const chosen = peaks.reduce((best, p) =>
    Math.abs(p.peak - target) < Math.abs(best.peak - target) ? p : best,
  );
  const { meta, records } = chosen.run;
  const own = records
    .filter((r) => r.client === chosen.client && r.status === ALLOWED)
    .map((r) => r.t)
    .sort((a, b) => a - b);
  const first = own[0] ?? 0;
  const series = own.map((t, i) => {
    let inWindow = 0;
    for (let j = i; j >= 0 && (own[j] ?? 0) > t - (meta.windowMs - RESOLUTION_MS); j--) inWindow++;
    return { t: t - first, allowed: inWindow };
  });
  return {
    algorithm: meta.algorithm,
    run: meta.run,
    peakPerWindow: chosen.peak,
    client: chosen.client,
    series,
  };
}

function byClient(records: readonly RequestRecord[]): Map<string, RequestRecord[]> {
  const out = new Map<string, RequestRecord[]>();
  for (const r of records) {
    const own = out.get(r.client);
    if (own === undefined) out.set(r.client, [r]);
    else own.push(r);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Chaos (milestone 4, T4): Redis killed or paused under steady load, then brought back. Every
// measure is per phase or around a change, from the fault times the runner recorded.

/** One fault the runner injected, timed by the host's clock when the command returned. */
export interface Fault {
  readonly action: 'kill' | 'start' | 'pause' | 'unpause';
  /** epoch ms */
  readonly at: number;
}

/** When Redis went away and when it came back, epoch ms. */
export interface Outage {
  readonly downAt: number;
  readonly upAt: number;
}

export type Phase = 'before' | 'outage' | 'after';
export const PHASES: readonly Phase[] = ['before', 'outage', 'after'];

const DOWN: ReadonlySet<Fault['action']> = new Set(['kill', 'pause']);

/** The outage in a run's faults: exactly one kill or pause, then the start or unpause after it. */
export function outageOf(faults: readonly Fault[]): Outage {
  const [down, up, ...rest] = [...faults].sort((a, b) => a.at - b.at);
  const pairs = { kill: 'start', pause: 'unpause' } as const;
  if (
    down === undefined ||
    up === undefined ||
    rest.length > 0 ||
    !DOWN.has(down.action) ||
    up.action !== pairs[down.action as 'kill' | 'pause']
  ) {
    throw new Error(
      `want a kill then a start, or a pause then an unpause: ${JSON.stringify(faults)}`,
    );
  }
  return { downAt: down.at, upAt: up.at };
}

/** Which phase a time falls in. A change belongs to the phase it starts. */
export function phaseOf(t: number, outage: Outage): Phase {
  if (t < outage.downAt) return 'before';
  return t < outage.upAt ? 'outage' : 'after';
}

/** A failed request: anything but a 200 or a 429, including 0 for no response at all. */
export function isFailure(r: RequestRecord): boolean {
  return r.status !== ALLOWED && r.status !== DENIED;
}

export interface PhaseStats {
  readonly requests: number;
  readonly failures: number;
  readonly e2eP99: number | undefined;
  readonly limiterP99: number | undefined;
  /** Share of limited requests the fallback decided, 0 to 1. */
  readonly fallbackShare: number | undefined;
}

export function phaseStats(
  records: readonly RequestRecord[],
  outage: Outage,
): Readonly<Record<Phase, PhaseStats>> {
  const split: Record<Phase, RequestRecord[]> = { before: [], outage: [], after: [] };
  for (const r of records) split[phaseOf(r.t, outage)].push(r);
  const stats = (rs: readonly RequestRecord[]): PhaseStats => {
    const limiter = rs.flatMap((r) => (r.limiterMs === undefined ? [] : [r.limiterMs]));
    const decided = rs.filter((r) => r.source !== undefined);
    return {
      requests: rs.length,
      failures: rs.filter(isFailure).length,
      e2eP99:
        rs.length > 0
          ? percentile(
              rs.map((r) => r.e2eMs),
              99,
            )
          : undefined,
      limiterP99: limiter.length > 0 ? percentile(limiter, 99) : undefined,
      fallbackShare:
        decided.length > 0
          ? decided.filter((r) => r.source === 'fallback').length / decided.length
          : undefined,
    };
  };
  return { before: stats(split.before), outage: stats(split.outage), after: stats(split.after) };
}

/**
 * The most requests allowed for one client in any window that spans `at`: the overshoot when
 * Redis goes away (the fallback's buckets start full) or comes back (empty, with no persistence).
 * Spans are `windowMs − RESOLUTION_MS` long and half-open, as in peakPerWindow. A span containing
 * `at` starts in `(at − span, at]`, and the busiest one can be slid right until it starts at a
 * request or at `at` itself, so only those starts need checking.
 */
export function peakAround(records: readonly RequestRecord[], windowMs: number, at: number): Peak {
  const span = windowMs - RESOLUTION_MS;
  let best: Peak = { peak: 0, client: undefined };
  for (const [client, own] of byClient(records)) {
    const times = own
      .filter((r) => r.status === ALLOWED)
      .map((r) => r.t)
      .sort((a, b) => a - b);
    const starts = [...times.filter((t) => t > at - span && t <= at), at];
    for (const s of starts) {
      const count = lowerBound(times, s + span) - lowerBound(times, s);
      if (count > best.peak) best = { peak: count, client };
    }
  }
  return best;
}

/** Index of the first value >= target in a sorted array. */
function lowerBound(sorted: readonly number[], target: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((sorted[mid] as number) < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export interface Recovery {
  /** Per instance: ms from Redis's return to its first primary decision, or undefined if none. */
  readonly byInstance: Readonly<Record<string, number | undefined>>;
  /** The slowest instance, or undefined if any never got back to the primary. */
  readonly worstMs: number | undefined;
}

/**
 * How long each instance took to decide from the primary again once Redis was back. The worst
 * one is what the demo sees: the fallback panel reaches zero only when every instance is back.
 */
export function recovery(records: readonly RequestRecord[], upAt: number): Recovery {
  const first = new Map<string, number | undefined>();
  for (const r of records) {
    if (r.instance === undefined) continue;
    if (!first.has(r.instance)) first.set(r.instance, undefined);
    if (r.source === 'primary' && r.t >= upAt) {
      const seen = first.get(r.instance);
      if (seen === undefined || r.t < seen) first.set(r.instance, r.t);
    }
  }
  const byInstance = Object.fromEntries(
    [...first]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([i, t]) => [i, t === undefined ? undefined : t - upAt]),
  );
  const values = Object.values(byInstance);
  return {
    byInstance,
    worstMs:
      values.length === 0 || values.some((v) => v === undefined)
        ? undefined
        : Math.max(...(values as number[])),
  };
}

export interface ChaosRun extends Run {
  readonly faults: readonly Fault[];
  /** Requests k6 couldn't start, from its summary. Undefined if not recorded. */
  readonly dropped?: number;
}

export interface ChaosMetrics {
  readonly phases: Readonly<Record<Phase, PhaseStats>>;
  readonly peakDown: number;
  readonly peakUp: number;
  readonly recoveryMs: number | undefined;
  readonly dropped: number | undefined;
}

export function chaosMetrics(run: ChaosRun): ChaosMetrics {
  const outage = outageOf(run.faults);
  return {
    phases: phaseStats(run.records, outage),
    peakDown: peakAround(run.records, run.meta.windowMs, outage.downAt).peak,
    peakUp: peakAround(run.records, run.meta.windowMs, outage.upAt).peak,
    recoveryMs: recovery(run.records, outage.upAt).worstMs,
    dropped: run.dropped,
  };
}

/**
 * One case (kill or pause): a row per algorithm, each cell the median of its runs, and a row per
 * run underneath, since a chaos test is judged on its worst run as much as its typical one.
 */
export function chaosTable(
  chaosCase: string,
  rule: Rule,
  runsByAlgorithm: readonly (readonly [string, readonly ChaosMetrics[]])[],
): string {
  const sorted = [...runsByAlgorithm].sort(([a], [b]) => byAlgorithmOrder(a, b));
  const failures = (m: ChaosMetrics) => PHASES.reduce((n, p) => n + m.phases[p].failures, 0);
  const mid = (values: (number | undefined)[]) => {
    const known = values.filter((v): v is number => v !== undefined);
    return known.length === values.length && known.length > 0 ? median(known) : undefined;
  };
  const row = (label: string, ms_: readonly ChaosMetrics[]) => {
    const p = (phase: Phase, pick: (s: PhaseStats) => number | undefined) =>
      mid(ms_.map((m) => pick(m.phases[phase])));
    return `| ${[
      label,
      String(ms_.reduce((n, m) => n + failures(m), 0)),
      PHASES.map((phase) => ms(p(phase, (s) => s.e2eP99))).join(' / '),
      ms(p('outage', (s) => s.limiterP99)),
      pct(p('outage', (s) => s.fallbackShare)),
      pct(p('after', (s) => s.fallbackShare)),
      count(mid(ms_.map((m) => m.peakDown)), rule.limit),
      count(mid(ms_.map((m) => m.peakUp)), rule.limit),
      ms_.some((m) => m.recoveryMs === undefined)
        ? 'never'
        : String(Math.round(mid(ms_.map((m) => m.recoveryMs)) ?? 0)),
      String(ms_.reduce((n, m) => n + (m.dropped ?? 0), 0)),
    ].join(' | ')} |`;
  };
  return [
    `## chaos: Redis ${chaosCase === 'kill' ? 'killed' : 'paused'}`,
    '',
    `Rule: ${String(rule.limit)} per ${String(rule.windowMs)} ms per client. Each algorithm's row is the median of its runs, except failed requests and k6's dropped iterations, which are totals; the rows under it are its runs. End-to-end p99 is before / during / after the outage. Peaks are the most one client got in a window spanning Redis going away, then coming back. Recovery is the slowest instance's time from Redis's return to its first decision from the primary.`,
    '',
    '| Algorithm | Failed requests | End-to-end p99 (ms) | Limiter p99, outage (ms) | Fallback share, outage | Fallback share, after | Peak, going away | Peak, coming back | Recovery (ms) | Dropped by k6 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...sorted.flatMap(([algorithm, metrics]) => [
      row(`**${algorithm}**`, metrics),
      ...metrics.map((m, i) => row(`run ${String(i + 1)}`, [m])),
    ]),
    '',
  ].join('\n');
}

const count = (v: number | undefined, limit: number) =>
  v === undefined ? '–' : `${String(v)} (${(v / limit).toFixed(2)}×)`;
