import { describe, expect, it } from 'vitest';
import { parseConsoleLog, parseRecordLine, resultsDirName } from '../../bench/records.ts';

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
