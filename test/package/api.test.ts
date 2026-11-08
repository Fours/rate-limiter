// The public API as npm users get it: what each entry point exports, and that every export is
// documented. Reads dist/, so `npm run test:package` builds first.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../..', import.meta.url));

// Changing either list changes the public API: say so in CHANGELOG.md. Removed before 1.0, in
// T3: `TokenBucket.sweep()` and `TokenBucket.size`, which were there for tests.
const EXPORTS = {
  'dist/index.d.ts': [
    'Algorithm',
    'Clock',
    'Decision',
    'DecisionEvent',
    'FallbackEvent',
    'FallbackOptions',
    'IdentifiableRequest',
    'InvalidRuleError',
    'IoredisLike',
    'NodeRedisLike',
    'RateLimitHooks',
    'RateLimitMiddleware',
    'RateLimitOptions',
    'RateLimitTimeoutError',
    'RedisAlgorithmOptions',
    'RedisScriptClient',
    'Rule',
    'RulesFormat',
    'TokenBucket',
    'TokenBucketOptions',
    'buildKey',
    'createRedisFixedWindow',
    'createRedisLeakyBucket',
    'createRedisSlidingWindowCounter',
    'createRedisSlidingWindowLog',
    'createRedisTokenBucket',
    'createTokenBucket',
    'defaultIdentify',
    'fromIoredis',
    'fromNodeRedis',
    'loadRules',
    'parseRules',
    'rateLimit',
    'systemClock',
  ],
  'dist/prometheus.d.ts': ['DEFAULT_BUCKETS', 'PrometheusHooksOptions', 'prometheusHooks'],
} as const;

const entries = Object.keys(EXPORTS) as (keyof typeof EXPORTS)[];
const program = ts.createProgram(
  entries.map((entry) => `${root}${entry}`),
  { module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext },
);
const checker = program.getTypeChecker();

/** Every export of an entry point, followed through re-exports to its declaration. */
function exportsOf(entry: string): ts.Symbol[] {
  const file = program.getSourceFile(`${root}${entry}`);
  if (file === undefined) throw new Error(`${entry} is missing: run npm run build`);
  const module = checker.getSymbolAtLocation(file);
  if (module === undefined) throw new Error(`${entry} has no exports`);
  return checker
    .getExportsOfModule(module)
    .map((symbol) =>
      symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol,
    );
}

describe('the public API', () => {
  it.each(entries)('%s exports exactly the listed names', (entry) => {
    const names = exportsOf(entry).map((symbol) => symbol.getName());
    expect(names.sort()).toStrictEqual([...EXPORTS[entry]].sort());
  });

  it.each(entries)('%s documents every export with TSDoc', (entry) => {
    const undocumented = exportsOf(entry)
      .filter((symbol) => symbol.getDocumentationComment(checker).length === 0)
      .map((symbol) => symbol.getName());
    expect(undocumented).toStrictEqual([]);
  });

  it('has the metadata npm shows, at version 1.0.0', () => {
    const pkg = JSON.parse(readFileSync(`${root}package.json`, 'utf8')) as {
      version?: unknown;
      description?: unknown;
      keywords?: unknown;
      homepage?: unknown;
      bugs?: { url?: unknown };
    };
    expect(pkg.version).toBe('1.0.0');
    expect(typeof pkg.description === 'string' && pkg.description !== '').toBe(true);
    expect(pkg.keywords).toEqual(expect.arrayContaining(['rate-limit', 'express', 'redis']));
    expect(pkg.homepage).toMatch(/^https:\/\//);
    expect(pkg.bugs?.url).toMatch(/^https:\/\//);
  });
});
