// Turns k6's console log into the RequestRecords the analysis reads, and k6's JSON output into
// per-second totals, and names results directories. Pure, so it has unit tests; bench/run.ts
// does the I/O.
import { percentile, type RequestRecord, type SecondTotals } from './analysis.ts';

// k6 writes each console.log as a logfmt line: time="…" level=info msg="REC …" source=console.
// The fields contain no quotes or spaces, so a plain pattern is enough.
const LINE = /msg="REC ([^"]*)"/;
const NUMBER = /^-?\d+(\.\d+)?$/;

/**
 * One REC line (see bench/k6/lib.ts) as a record, or undefined for any other line, such as
 * k6's own warnings. A malformed REC line throws: a silently dropped request would skew counts.
 */
export function parseRecordLine(line: string): RequestRecord | undefined {
  const match = LINE.exec(line);
  if (match === null) return undefined;
  const fields = (match[1] ?? '').split(' ');
  const [client, receivedAt, sentAt, status, e2eMs, limiterMs] = fields;
  const bad = (why: string) => new Error(`bad REC line (${why}): ${line}`);
  if (fields.length !== 6 || client === undefined || client === '') throw bad('want 6 fields');
  const num = (value: string | undefined, name: string): number => {
    if (value === undefined || !NUMBER.test(value)) throw bad(`${name} is not a number`);
    return Number(value);
  };
  const sent = num(sentAt, 'sentAt');
  return {
    client,
    t: receivedAt === '-' ? sent : num(receivedAt, 'receivedAt'),
    sentAt: sent,
    status: num(status, 'status'),
    e2eMs: num(e2eMs, 'e2eMs'),
    ...(limiterMs === '-' ? {} : { limiterMs: num(limiterMs, 'limiterMs') }),
  };
}

/** Every REC line in a k6 console log, in order. */
export function parseConsoleLog(text: string): RequestRecord[] {
  return text.split('\n').flatMap((line) => {
    const record = parseRecordLine(line);
    return record === undefined ? [] : [record];
  });
}

/**
 * Per-second totals from k6's JSON output (`--out json`), one line at a time, so a ramp run's
 * million-odd lines never sit in memory as text. The ramp uses this instead of REC lines,
 * because logging every request capped k6 near 20,000 req/s (decision 0017).
 *
 * Each `http_req_duration` point is one request: its time is when the response arrived, its
 * value the end-to-end ms, and its `status` tag the response's status (0 if none came).
 * `dropped_iterations` points are requests k6 couldn't start. Every other line is ignored.
 */
export class K6Seconds {
  private readonly durations = new Map<number, number[]>();
  private readonly unhealthy = new Set<number>();
  private readonly dropped = new Map<number, number>();

  add(line: string): void {
    // Cheap test first: most lines are points of metrics this doesn't read.
    if (!line.includes('"http_req_duration"') && !line.includes('"dropped_iterations"')) return;
    const point = JSON.parse(line) as {
      type?: string;
      metric?: string;
      data?: { time?: string; value?: number; tags?: { status?: string } };
    };
    if (point.type !== 'Point') return;
    const { time, value, tags } = point.data ?? {};
    const at = time === undefined ? NaN : Date.parse(time);
    if (Number.isNaN(at) || typeof value !== 'number') {
      throw new Error(`bad k6 point (want data.time and data.value): ${line}`);
    }
    const second = Math.floor(at / 1000);
    if (point.metric === 'dropped_iterations') {
      this.dropped.set(second, (this.dropped.get(second) ?? 0) + value);
    } else if (point.metric === 'http_req_duration') {
      const bucket = this.durations.get(second);
      if (bucket === undefined) this.durations.set(second, [value]);
      else bucket.push(value);
      const status = tags?.status;
      if (status !== '200' && status !== '429') this.unhealthy.add(second);
    }
  }

  /** Every second that had a response or a drop, in order. */
  totals(): SecondTotals[] {
    const seconds = [...new Set([...this.durations.keys(), ...this.dropped.keys()])];
    return seconds
      .sort((a, b) => a - b)
      .map((second) => {
        const durations = this.durations.get(second) ?? [];
        return {
          second,
          count: durations.length,
          healthy: !this.unhealthy.has(second),
          // A second with only drops had no responses, so no latency to report.
          p99: durations.length === 0 ? 0 : percentile(durations, 99),
          dropped: this.dropped.get(second) ?? 0,
        };
      });
  }
}

/** Calls per command from Redis `INFO commandstats`, e.g. `{ evalsha: 1500, ping: 60 }`. */
export function parseCommandStats(info: string): Record<string, number> {
  const calls: Record<string, number> = {};
  for (const line of info.split(/\r?\n/)) {
    const match = /^cmdstat_([^:]+):calls=(\d+),/.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined) calls[match[1]] = Number(match[2]);
  }
  return calls;
}

/**
 * Commands that aren't the limiter's: the Compose healthcheck pings every second, the runner
 * reads `INFO` before and after, and `redis-cli` may ask for `COMMAND DOCS` when it connects.
 */
const NOT_THE_LIMITER = /^(ping|info|command(\|.*)?)$/;

/**
 * The limiter's Redis calls during a run, per command: the difference between two
 * `INFO commandstats` snapshots, leaving out commands that aren't the limiter's.
 */
export function redisCallsBetween(
  before: Readonly<Record<string, number>>,
  after: Readonly<Record<string, number>>,
): Record<string, number> {
  const calls: Record<string, number> = {};
  for (const [command, n] of Object.entries(after)) {
    const delta = n - (before[command] ?? 0);
    if (delta > 0 && !NOT_THE_LIMITER.test(command)) calls[command] = delta;
  }
  return calls;
}

/**
 * `<decision>-<scenario>-<date>`, or with `-2`, `-3`… if that name is taken, so a second run on
 * the same day never overwrites the first. The decision is the record the data is evidence for.
 */
export function resultsDirName(
  scenario: string,
  date: Date,
  existing: readonly string[],
  decision = '0008',
): string {
  const base = `${decision}-${scenario}-${date.toISOString().slice(0, 10)}`;
  if (!existing.includes(base)) return base;
  for (let n = 2; ; n++) {
    const name = `${base}-${String(n)}`;
    if (!existing.includes(name)) return name;
  }
}
