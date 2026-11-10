import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { RECORDS, recordUrl } from '../../demo/src/writeup/records.ts';

const DECISIONS = fileURLToPath(new URL('../../docs/decisions/', import.meta.url));

describe("the write-up's record links", () => {
  it('list exactly the records in docs/decisions/', () => {
    const files = readdirSync(DECISIONS)
      .filter((f) => /^\d{4}-.+\.md$/.test(f))
      .map((f) => f.replace(/\.md$/, ''))
      .sort();
    expect(Object.values(RECORDS).sort()).toEqual(files);
  });

  it('key each record by its number', () => {
    for (const [id, slug] of Object.entries(RECORDS)) expect(slug.startsWith(`${id}-`)).toBe(true);
  });

  it('point at the record on GitHub', () => {
    expect(recordUrl('0008')).toBe(
      'https://github.com/Fours/rate-limiter/blob/main/docs/decisions/0008-sliding-window-accuracy-vs-cost.md',
    );
  });
});
