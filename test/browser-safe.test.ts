import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The demo runs these modules in the browser (decision 0024), so neither they nor anything they
 * import may use a Node built-in. Vite would bundle an empty stand-in for one, and the page would
 * fail only when the code ran.
 */
const BROWSER_SAFE = [
  'src/algorithms/redis/factory.ts',
  'src/redis/scripts.ts',
  'src/redis/client.ts',
  'src/algorithms/token-bucket.ts',
  'src/headers.ts',
  'src/fallback.ts',
  'src/timeout.ts',
];

function importsOf(file: string): string[] {
  const source = readFileSync(file, 'utf8');
  return [...source.matchAll(/^\s*(?:import|export)\b[^'"]*?from\s+'([^']+)'/gm)].map(
    (match) => match[1] ?? '',
  );
}

/** Every module `file` reaches through relative imports, with the bare imports each one makes. */
function walk(file: string, seen = new Map<string, string[]>()): Map<string, string[]> {
  if (seen.has(file)) return seen;
  const specifiers = importsOf(file);
  seen.set(
    file,
    specifiers.filter((s) => !s.startsWith('.')),
  );
  for (const s of specifiers.filter((s) => s.startsWith('.'))) {
    walk(resolve(dirname(file), s.replace(/\.js$/, '.ts')), seen);
  }
  return seen;
}

describe('modules the demo runs in the browser', () => {
  it.each(BROWSER_SAFE)('%s imports no Node built-in, directly or not', (file) => {
    const bare = [...walk(resolve(file))].flatMap(([from, specifiers]) =>
      specifiers.map((s) => `${from}: ${s}`),
    );
    expect(bare).toEqual([]);
  });

  it('notices one', () => {
    expect(
      walk(resolve('src/algorithms/redis/load-script.ts')).get(
        resolve('src/algorithms/redis/load-script.ts'),
      ),
    ).toEqual(['node:crypto', 'node:fs']);
  });
});
