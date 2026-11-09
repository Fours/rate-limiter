import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createScriptRunner,
  scriptSha,
  standInClient,
  type ScriptRunner,
} from '../../demo/src/redis/lua.ts';
import { ALGORITHMS, createAlgorithms, SCRIPT_SOURCES } from '../../demo/src/redis/scripts.ts';
import { StandInRedis } from '../../demo/src/redis/stand-in.ts';
import { defaultBurstOf } from '../../src/algorithms/default-burst.js';
import { defineScript, loadScript } from '../../src/algorithms/redis/load-script.js';
import type { Rule } from '../../src/types.js';
import { FakeClock } from '../helpers/fake-clock.js';

// One engine for the file: starting wasmoon takes a moment, and each test gets a new Redis.
let clock: FakeClock;
let redis: StandInRedis;
let runner: ScriptRunner;
const current = { redis: undefined as StandInRedis | undefined };

beforeAll(async () => {
  // The runner calls whichever stand-in the current test made.
  const proxy = new StandInRedis(() => clock.now());
  proxy.call = (name, ...args) => {
    if (current.redis === undefined) throw new Error('no stand-in');
    return current.redis.call(name, ...args);
  };
  runner = await createScriptRunner(proxy);
});

afterAll(() => {
  runner.close();
});

beforeEach(() => {
  clock = new FakeClock(1_700_000_000_000);
  redis = new StandInRedis(() => clock.now());
  current.redis = redis;
});

const rule = (overrides: Partial<Rule> = {}): Rule => ({
  id: 'r',
  limit: 3,
  windowMs: 1_000,
  ...overrides,
});

describe('the scripts the demo runs', () => {
  it.each(ALGORITHMS)('%s is exactly what the package loads, with the same SHA', async (name) => {
    const shipped = loadScript(`../../src/algorithms/redis/${name}.lua`, import.meta.url);
    expect(SCRIPT_SOURCES[name]).toBe(shipped.source);
    expect(await scriptSha(SCRIPT_SOURCES[name])).toBe(shipped.sha);
  });

  it('scriptSha is SHA-1, as Redis names scripts', async () => {
    expect(await scriptSha('return 1')).toBe(defineScript('return 1').sha);
    expect(await scriptSha('return 1')).toBe('e0e1f9fabfc9d4800c877a703b823ac0578ff8db');
  });
});

describe('the runner', () => {
  it('sets KEYS and ARGV, and truncates numbers in the reply, as Redis does', () => {
    expect(runner.run('return {KEYS[1], ARGV[2], 1.9, -1.9, 7}', ['k'], ['a', 'b'])).toEqual([
      'k',
      'b',
      1,
      -1,
      7,
    ]);
  });

  it('passes redis.call through to the stand-in, and its errors back as Lua errors', () => {
    expect(runner.run("return redis.call('HSET', KEYS[1], 'f', 1)", ['k'], [])).toBe(1);
    expect(redis.dump('k')).toEqual({ type: 'hash', value: { f: '1' } });
    redis.call('ZADD', 'z', 1, 'm');
    expect(() => runner.run("return redis.call('HGET', KEYS[1], 'f')", ['z'], [])).toThrow(
      /WRONGTYPE/,
    );
  });
});

describe('the client', () => {
  it('EVALSHA gets NOSCRIPT until EVAL has cached the script', async () => {
    const client = standInClient(redis, runner);
    const source = 'return 42';
    const sha = await scriptSha(source);
    await expect(client.evalsha(sha, [], [])).rejects.toThrow(/^NOSCRIPT/);
    await expect(client.eval(source, [], [])).resolves.toBe(42);
    expect(redis.scripts.get(sha)).toBe(source);
    await expect(client.evalsha(sha, [], [])).resolves.toBe(42);
  });

  it('fails both while Redis is down, without caching anything', async () => {
    const client = standInClient(redis, runner);
    redis.setDown(true);
    await expect(client.eval('return 1', [], [])).rejects.toThrow(/down/);
    await expect(client.evalsha('abc', [], [])).rejects.toThrow(/down/);
    expect(redis.scripts.size).toBe(0);
  });
});

describe('the five algorithms over the stand-in', () => {
  it.each(ALGORITHMS)('%s allows the limit, then denies, then allows again later', async (name) => {
    const algorithm = (await createAlgorithms(standInClient(redis, runner)))[name];
    // The leaky bucket takes no burst by default (0014), so it allows one at once, not three.
    const atOnce = name === 'leaky-bucket' ? 1 : 3;
    const r = rule();
    const allowed = [];
    for (let i = 0; i < 4; i++) allowed.push((await algorithm.check('rl:r:c', r)).allowed);
    expect(allowed).toEqual([true, true, true, false].map((_, i) => i < atOnce));
    clock.advance(2_000);
    expect((await algorithm.check('rl:r:c', r)).allowed).toBe(true);
  });

  it('only the two buckets take a burst', async () => {
    const algorithms = await createAlgorithms(standInClient(redis, runner));
    expect(ALGORITHMS.filter((name) => algorithms[name].supportsBurst === true)).toEqual([
      'token-bucket',
      'leaky-bucket',
    ]);
  });

  it("marks the leaky bucket's default burst of 1, as createRedisLeakyBucket does", async () => {
    const algorithms = await createAlgorithms(standInClient(redis, runner));
    expect(ALGORITHMS.map((name) => defaultBurstOf(algorithms[name]))).toEqual([
      undefined,
      1,
      undefined,
      undefined,
      undefined,
    ]);
  });

  it('keys expire on simulated time', async () => {
    const { 'fixed-window': fixed } = await createAlgorithms(standInClient(redis, runner));
    await fixed.check('rl:r:c', rule());
    expect(redis.keys()).toEqual(['rl:r:c']);
    clock.advance(1_000);
    expect(redis.keys()).toEqual([]);
  });

  it('after a restart, checks recover through the NOSCRIPT retry, with the count kept', async () => {
    const { 'token-bucket': bucket } = await createAlgorithms(standInClient(redis, runner));
    const r = rule({ windowMs: 60_000 });
    await bucket.check('rl:r:c', r);
    await bucket.check('rl:r:c', r);
    redis.setDown(true);
    await expect(bucket.check('rl:r:c', r)).rejects.toThrow(/down/);
    redis.setDown(false);
    expect(redis.scripts.size).toBe(0);
    expect(await bucket.check('rl:r:c', r)).toMatchObject({ allowed: true, remaining: 0 });
    expect(redis.scripts.size).toBe(1);
  });

  it('another algorithm taking over a key starts the client fresh (0016)', async () => {
    const algorithms = await createAlgorithms(standInClient(redis, runner));
    const r = rule({ limit: 1 });
    expect((await algorithms['sliding-window-log'].check('rl:r:c', r)).allowed).toBe(true);
    expect((await algorithms['sliding-window-log'].check('rl:r:c', r)).allowed).toBe(false);
    expect((await algorithms['token-bucket'].check('rl:r:c', r)).allowed).toBe(true);
    expect(redis.dump('rl:r:c').type).toBe('hash');
  });
});
