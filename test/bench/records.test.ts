import { describe, expect, it } from 'vitest';
import {
  K6Seconds,
  parseConsoleLog,
  parseCommandStats,
  parseRecordLine,
  redisCallsBetween,
  resultsDirName,
} from '../../bench/records.ts';

const line = (msg: string) => `time="2026-11-06T22:47:42Z" level=info msg="${msg}" source=console`;

describe('parseRecordLine', () => {
  it('reads every field, timing windows by when the app received the request', () => {
    expect(
      parseRecordLine(line('REC steady-736 1794005262105.906 1794005262101 200 2.916 1.686')),
    ).toEqual({
      client: 'steady-736',
      t: 1794005262105.906,
      sentAt: 1794005262101,
      status: 200,
      e2eMs: 2.916,
      limiterMs: 1.686,
    });
  });

  it('leaves the limiter time out when there was none (ALGORITHM=none)', () => {
    const record = parseRecordLine(line('REC c 1000.5 999 200 1.5 -'));
    expect(record).toEqual({ client: 'c', t: 1000.5, sentAt: 999, status: 200, e2eMs: 1.5 });
    expect(record).not.toHaveProperty('limiterMs');
  });

  it('falls back to the send time for a request that got no response', () => {
    expect(parseRecordLine(line('REC c - 999 0 10000.000 -'))).toMatchObject({ t: 999, status: 0 });
  });

  it('ignores lines that are not records', () => {
    expect(
      parseRecordLine('time="…" level=warning msg="Insufficient VUs" source=k6'),
    ).toBeUndefined();
    expect(parseRecordLine('')).toBeUndefined();
  });

  it('rejects a malformed record instead of dropping it', () => {
    expect(() => parseRecordLine(line('REC c 1000 999 200 1.5'))).toThrow(/want 6 fields/);
    expect(() => parseRecordLine(line('REC c 1000 999 OK 1.5 -'))).toThrow(
      /status is not a number/,
    );
    expect(() => parseRecordLine(line('REC  1000 999 200 1.5 -'))).toThrow(/want 6 fields/);
  });
});

describe('parseConsoleLog', () => {
  it('keeps records in order and skips everything else', () => {
    const log = [
      line('REC a 2 1 200 1 0.5'),
      'time="…" level=warning msg="Request Failed" source=k6',
      line('REC b 4 3 429 1 0.4'),
      '',
    ].join('\n');
    expect(parseConsoleLog(log).map((r) => r.client)).toEqual(['a', 'b']);
  });
});

describe('resultsDirName', () => {
  it('prefixes the decision the data is evidence for', () => {
    expect(resultsDirName('steady-15000rps', new Date('2026-11-07T12:00:00Z'), [], '0009')).toBe(
      '0009-steady-15000rps-2026-11-07',
    );
  });

  const day = new Date('2026-11-06T22:00:00Z');

  it('names a directory after the decision, scenario and date', () => {
    expect(resultsDirName('edges', day, [])).toBe('0008-edges-2026-11-06');
  });

  it('never reuses a name taken earlier the same day', () => {
    expect(resultsDirName('edges', day, ['0008-edges-2026-11-06'])).toBe('0008-edges-2026-11-06-2');
    expect(resultsDirName('edges', day, ['0008-edges-2026-11-06', '0008-edges-2026-11-06-2'])).toBe(
      '0008-edges-2026-11-06-3',
    );
    expect(resultsDirName('steady', day, ['0008-edges-2026-11-06'])).toBe('0008-steady-2026-11-06');
  });
});

describe('K6Seconds', () => {
  // Lines as k6 2.3.0 writes them with --out json (trimmed to the fields that matter).
  const point = (metric: string, time: string, value: number, status?: string) =>
    JSON.stringify({
      metric,
      type: 'Point',
      data: { time, value, tags: status === undefined ? {} : { status, name: 'work' } },
    });
  const duration = (time: string, ms: number, status = '200') =>
    point('http_req_duration', time, ms, status);

  const totalsOf = (lines: readonly string[]) => {
    const totals = new K6Seconds();
    for (const line of lines) totals.add(line);
    return totals.totals();
  };

  it('counts responses per second of arrival, with a nearest-rank p99', () => {
    expect(
      totalsOf([
        duration('2026-11-07T01:02:13.100000000Z', 1),
        duration('2026-11-07T01:02:13.999999999Z', 3, '429'),
        duration('2026-11-07T01:02:14.000000001Z', 7),
      ]),
    ).toEqual([
      { second: 1794013333, count: 2, healthy: true, p99: 3, dropped: 0 },
      { second: 1794013334, count: 1, healthy: true, p99: 7, dropped: 0 },
    ]);
  });

  it('marks a second unhealthy for any status but 200 or 429, including no response', () => {
    const seconds = totalsOf([
      duration('2026-11-07T01:02:13.1Z', 1, '503'),
      duration('2026-11-07T01:02:14.1Z', 1, '0'),
      duration('2026-11-07T01:02:15.1Z', 1, '429'),
    ]);
    expect(seconds.map((s) => s.healthy)).toEqual([false, false, true]);
  });

  it("sums k6's dropped iterations per second, even in a second with no responses", () => {
    expect(
      totalsOf([
        duration('2026-11-07T01:02:13.1Z', 1),
        point('dropped_iterations', '2026-11-07T01:02:13.2Z', 1),
        point('dropped_iterations', '2026-11-07T01:02:13.3Z', 2),
        point('dropped_iterations', '2026-11-07T01:02:14.3Z', 4),
      ]),
    ).toEqual([
      { second: 1794013333, count: 1, healthy: true, p99: 1, dropped: 3 },
      { second: 1794013334, count: 0, healthy: true, p99: 0, dropped: 4 },
    ]);
  });

  it('ignores metric declarations and the points of other metrics', () => {
    expect(
      totalsOf([
        JSON.stringify({ type: 'Metric', metric: 'http_req_duration', data: { name: 'x' } }),
        point('http_reqs', '2026-11-07T01:02:13.1Z', 1, '200'),
        point('http_req_waiting', '2026-11-07T01:02:13.1Z', 1, '503'),
        '',
      ]),
    ).toEqual([]);
  });

  it("throws on a point it can't place, rather than drop a request", () => {
    const totals = new K6Seconds();
    expect(() => {
      totals.add(point('http_req_duration', 'not a time', 1, '200'));
    }).toThrow(/bad k6 point/);
  });
});

describe('parseCommandStats', () => {
  it('reads calls per command, subcommands included, from INFO commandstats', () => {
    const info = [
      '# Commandstats',
      'cmdstat_evalsha:calls=1500,usec=9000,usec_per_call=6.00,rejected_calls=0,failed_calls=0',
      'cmdstat_ping:calls=61,usec=40,usec_per_call=0.66,rejected_calls=0,failed_calls=0',
      'cmdstat_command|docs:calls=1,usec=900,usec_per_call=900.00,rejected_calls=0,failed_calls=0',
      '',
    ].join('\r\n');
    expect(parseCommandStats(info)).toEqual({ evalsha: 1500, ping: 61, 'command|docs': 1 });
  });

  it('gives nothing for a Redis that has run no commands', () => {
    expect(parseCommandStats('# Commandstats\r\n')).toEqual({});
  });
});

describe('redisCallsBetween', () => {
  it("counts each command's calls between two snapshots", () => {
    expect(
      redisCallsBetween({ evalsha: 10, script: 1 }, { evalsha: 1510, script: 1, eval: 2 }),
    ).toEqual({ evalsha: 1500, eval: 2 });
  });

  it("leaves out the healthcheck's PING, the runner's INFO and redis-cli's COMMAND DOCS", () => {
    expect(
      redisCallsBetween(
        { ping: 1, info: 1 },
        { ping: 61, info: 2, 'command|docs': 1, command: 1, evalsha: 5 },
      ),
    ).toEqual({ evalsha: 5 });
  });
});
