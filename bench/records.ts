// Turns k6's console log into the RequestRecords the analysis reads, and names results
// directories. Pure, so it has unit tests; bench/run.ts does the I/O.
import type { RequestRecord } from './analysis.ts';

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
 * `0008-<scenario>-<date>`, or with `-2`, `-3`… if that name is taken, so a second run on the same
 * day never overwrites the first.
 */
export function resultsDirName(scenario: string, date: Date, existing: readonly string[]): string {
  const base = `0008-${scenario}-${date.toISOString().slice(0, 10)}`;
  if (!existing.includes(base)) return base;
  for (let n = 2; ; n++) {
    const name = `${base}-${String(n)}`;
    if (!existing.includes(name)) return name;
  }
}
