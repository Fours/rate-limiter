// Runs against the built dist/, through package.json's exports, the way an app would import the
// package. `npm run test:package` builds first. Each check runs in a fresh Node process, so
// nothing vitest has already loaded can hide what the package itself loads.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../..', import.meta.url));

/**
 * Runs an ES module in Node from the repo root, where the package can import itself by name.
 * A resolve hook records every module URL loaded, ESM and CommonJS alike, in `loaded`.
 */
function run(body: string): string {
  const script = `
    import { registerHooks } from 'node:module';
    const loaded = [];
    registerHooks({ resolve(specifier, context, next) {
      const result = next(specifier, context);
      loaded.push(result.url);
      return result;
    } });
    ${body}
  `;
  return execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: root,
    encoding: 'utf8',
  });
}

describe('the built package', () => {
  it('resolves @kylewillett/rate-limiter/prometheus to dist/, with its types', () => {
    const resolved = run(
      `console.log(import.meta.resolve('@kylewillett/rate-limiter/prometheus'));`,
    ).trim();
    expect(resolved).toBe(new URL('dist/prometheus.js', `file://${root}`).href);

    const pkg = JSON.parse(readFileSync(`${root}package.json`, 'utf8')) as {
      exports: Record<string, { types: string }>;
    };
    const types = pkg.exports['./prometheus']?.types;
    expect(types).toBe('./dist/prometheus.d.ts');
    expect(existsSync(`${root}${types ?? ''}`)).toBe(true);
  });

  it('records metrics through the prometheus entry point', () => {
    const output = run(`
      const { Registry } = await import('prom-client');
      const { prometheusHooks } = await import('@kylewillett/rate-limiter/prometheus');
      const registry = new Registry();
      const hooks = prometheusHooks({ registry });
      hooks.onDecision({
        rule: { id: 'api', limit: 1, windowMs: 1000 },
        decision: { allowed: false, remaining: 0, resetMs: 1000 },
        source: 'primary',
        durationMs: 0.2,
      });
      console.log(await registry.metrics());
    `);
    expect(output).toContain(
      'ratelimit_decisions_total{rule="api",outcome="denied",source="primary"} 1',
    );
  });

  it('never loads prom-client from the main entry point', () => {
    const output = run(`
      const main = await import('@kylewillett/rate-limiter');
      if (typeof main.rateLimit !== 'function') throw new Error('main entry did not load');
      console.log(JSON.stringify(loaded));
    `);
    const loaded = JSON.parse(output) as string[];
    // The hook must have seen the package itself, or an empty list would pass for the wrong reason.
    expect(loaded).toContain(new URL('dist/index.js', `file://${root}`).href);
    expect(loaded.filter((url) => url.includes('prom-client'))).toStrictEqual([]);
  });
});
