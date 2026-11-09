import { describe, expect, it } from 'vitest';
import { loadScript } from '../../src/algorithms/redis/load-script.js';
import { runScript } from '../../src/redis/scripts.js';
import { useRedis } from './helpers/algorithms.js';

// Found by mutation testing: every algorithm test overrides the time, so nothing checked the
// arithmetic that turns Redis TIME into milliseconds. Scaling it, rounding it up or dropping the
// microseconds all passed.
const r = useRedis();
const now = loadScript('../fixtures/lua/now.lua', import.meta.url);

describe('rl_now', () => {
  it('is Redis TIME in whole milliseconds, rounded down', async () => {
    for (let i = 0; i < 50; i++) {
      const [before, at, after] = (await runScript(r.client, now, [], [''])) as number[];
      expect(at).toBeGreaterThanOrEqual(before ?? Number.NaN);
      expect(at).toBeLessThanOrEqual(after ?? Number.NaN);
    }
  });

  it('is close to the app server time, in ms since the epoch', async () => {
    const [, at] = (await runScript(r.client, now, [], [''])) as number[];
    // The test Redis runs on this machine, so the clocks agree to well within a second.
    expect(Math.abs((at ?? 0) - Date.now())).toBeLessThan(1_000);
  });

  it('uses the override when one is given, for tests', async () => {
    const [, at] = (await runScript(r.client, now, [], ['1700000000123'])) as number[];
    expect(at).toBe(1_700_000_000_123);
  });
});
