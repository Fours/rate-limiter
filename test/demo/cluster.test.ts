import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createScriptRunner, standInClient, type ScriptRunner } from '../../demo/src/redis/lua.ts';
import { ALGORITHMS, createAlgorithms, type AlgorithmName } from '../../demo/src/redis/scripts.ts';
import { StandInRedis } from '../../demo/src/redis/stand-in.ts';
import { SimClock } from '../../demo/src/sim/clock.ts';
import { createCluster, type Cluster, type SimResponse } from '../../demo/src/sim/cluster.ts';
import { AFTER_EDGE_MS, BEFORE_EDGE_MS, burstAcrossEdge } from '../../demo/src/sim/edge-burst.ts';
import { maxAllowedInAnyWindow, nextWindowEdge } from '../../demo/src/sim/timeline.ts';
import type { Rule } from '../../src/types.js';

// The demo's rule: 6 per 10 s, so each of three instances' fallbacks allows exactly 2.
const RULE: Rule = { id: 'demo', limit: 6, windowMs: 10_000 };
// Mid-window, so a burst of 7 never crosses an edge.
const START = 1_767_225_603_000;

let clock: SimClock;
let redis: StandInRedis;
let runner: ScriptRunner;
let cluster: Cluster;
const current = { redis: undefined as StandInRedis | undefined };

beforeAll(async () => {
  // One engine for the file, calling whichever stand-in the current test made.
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

beforeEach(async () => {
  clock = new SimClock(START);
  redis = new StandInRedis(() => clock.now());
  current.redis = redis;
  cluster = createCluster({
    algorithms: await createAlgorithms(standInClient(redis, runner)),
    redis,
    clock,
  });
});

afterEach(() => {
  cluster.close();
});

async function sendMany(n: number, algorithm: AlgorithmName = 'token-bucket') {
  const out: SimResponse[] = [];
  for (let i = 0; i < n; i++) {
    const [response] = await cluster.send(RULE, [algorithm]);
    if (response === undefined) throw new Error('no response');
    out.push(response);
  }
  return out;
}

describe('the simulated cluster', () => {
  it('sends requests round robin over three instances', async () => {
    const responses = await sendMany(7);
    expect(responses.map((r) => r.instance)).toEqual([1, 2, 3, 1, 2, 3, 1]);
    expect(responses.map((r) => r.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('keeps round robin in order for requests sent together', async () => {
    const responses = await Promise.all(
      [1, 2, 3, 4].map(() => cluster.send(RULE, ['fixed-window'])),
    );
    expect(responses.flat().map((r) => r.instance)).toEqual([1, 2, 3, 1]);
  });

  it.each(ALGORITHMS)('%s shares one limit across the instances', async (name) => {
    // The leaky bucket spaces requests out with no burst, so it allows one at once.
    const atOnce = name === 'leaky-bucket' ? 1 : RULE.limit;
    const responses = await sendMany(RULE.limit + 1, name);
    expect(responses.map((r) => r.status)).toEqual(
      responses.map((_, i) => (i < atOnce ? 200 : 429)),
    );
    expect(new Set(responses.map((r) => r.source))).toEqual(new Set(['shared']));
    expect(new Set(responses.map((r) => r.key))).toEqual(new Set([`rl:demo-${name}:visitor`]));
  });

  it('counts down the headers whichever instance answers, and sets Retry-After on a 429', async () => {
    const responses = await sendMany(RULE.limit + 1);
    expect(responses.map((r) => r.headers['RateLimit-Remaining'])).toEqual([
      '5',
      '4',
      '3',
      '2',
      '1',
      '0',
      '0',
    ]);
    expect(responses.every((r) => r.headers['RateLimit-Limit'] === '6')).toBe(true);
    expect(responses.slice(0, 6).every((r) => !('Retry-After' in r.headers))).toBe(true);
    const denied = responses[6];
    expect(denied?.status).toBe(429);
    expect(denied?.headers['Retry-After']).toBe(denied?.headers['RateLimit-Reset']);
    expect(Number(denied?.headers['Retry-After'])).toBeGreaterThanOrEqual(1);
  });

  it("answers from each instance's own fallback while Redis is down", async () => {
    cluster.setRedisDown(true);
    expect(cluster.redisDown).toBe(true);
    const responses = await sendMany(12);
    expect(new Set(responses.map((r) => r.source))).toEqual(new Set(['fallback']));
    // Each instance allows its own share, 2 of 6, so the three together allow about the limit.
    for (const instance of [1, 2, 3]) {
      const own = responses.filter((r) => r.instance === instance);
      expect(own.map((r) => r.status)).toEqual([200, 200, 429, 429]);
      expect(own.map((r) => r.headers['RateLimit-Limit'])).toEqual(['2', '2', '2', '2']);
    }
    // Nothing reached Redis.
    expect(redis.keys()).toEqual([]);
  });

  it("keeps each instance's fallback count apart", async () => {
    cluster.setRedisDown(true);
    // Six requests use up every share; instance 1 alone has used only its own.
    const first = await sendMany(3);
    expect(first.map((r) => r.headers['RateLimit-Remaining'])).toEqual(['1', '1', '1']);
  });

  it("keeps the leaky bucket's no-burst in the fallback, as the middleware does", async () => {
    cluster.setRedisDown(true);
    const responses = await sendMany(6, 'leaky-bucket');
    expect(responses.map((r) => r.status)).toEqual([200, 200, 200, 429, 429, 429]);
  });

  it('gets the shared count back once Redis returns', async () => {
    const before = await sendMany(4);
    expect(before.every((r) => r.status === 200)).toBe(true);
    cluster.setRedisDown(true);
    await sendMany(3);
    cluster.setRedisDown(false);
    // The 4 sent before the outage still count; those the fallbacks answered never reached Redis.
    const after = await sendMany(3);
    expect(after.map((r) => r.source)).toEqual(['shared', 'shared', 'shared']);
    expect(after.map((r) => r.status)).toEqual([200, 200, 429]);
    expect(after.map((r) => r.headers['RateLimit-Remaining'])).toEqual(['1', '0', '0']);
  });

  it('checks every algorithm it is given with the same request, on one instance', async () => {
    const responses = await cluster.send(RULE, ['fixed-window', 'sliding-window-log']);
    expect(responses.map((r) => [r.seq, r.instance, r.algorithm, r.key])).toEqual([
      [1, 1, 'fixed-window', 'rl:demo-fixed-window:visitor'],
      [1, 1, 'sliding-window-log', 'rl:demo-sliding-window-log:visitor'],
    ]);
  });

  it('reset starts again from the first instance, with empty fallbacks', async () => {
    cluster.setRedisDown(true);
    await sendMany(5);
    cluster.reset();
    const [first] = await sendMany(1);
    expect(first?.instance).toBe(1);
    expect(first?.seq).toBe(1);
    expect(first?.headers['RateLimit-Remaining']).toBe('1');
  });
});

describe('a burst across a window edge', () => {
  const pair = ['fixed-window', 'sliding-window-log'] as const;

  it('lets the fixed window allow twice the limit, and the sliding window log only the limit', async () => {
    const responses = await burstAcrossEdge(cluster, clock, RULE, pair, 'edge-1');
    const fixed = responses.filter((r) => r.algorithm === 'fixed-window');
    const log = responses.filter((r) => r.algorithm === 'sliding-window-log');
    // Same requests, at the same moments.
    expect(fixed.map((r) => r.at)).toEqual(log.map((r) => r.at));
    expect(fixed).toHaveLength(2 * RULE.limit);

    expect(fixed.every((r) => r.status === 200)).toBe(true);
    expect(maxAllowedInAnyWindow(fixed, RULE.windowMs)).toBe(2 * RULE.limit);
    expect(log.filter((r) => r.status === 200)).toHaveLength(RULE.limit);
    expect(maxAllowedInAnyWindow(log, RULE.windowMs)).toBe(RULE.limit);
  });

  it('straddles the edge: half before it, half after, all within a second', async () => {
    const responses = await burstAcrossEdge(cluster, clock, RULE, ['fixed-window'], 'edge-2');
    const edge = nextWindowEdge(START, RULE.windowMs);
    const times = responses.map((r) => r.at);
    expect(times.filter((t) => t < edge)).toHaveLength(RULE.limit);
    expect(times.filter((t) => t >= edge)).toHaveLength(RULE.limit);
    expect(Math.min(...times)).toBe(edge - BEFORE_EDGE_MS);
    expect(Math.max(...times) - Math.min(...times)).toBeLessThan(1_000);
    expect(Math.min(...times.filter((t) => t >= edge))).toBe(edge + AFTER_EDGE_MS);
  });

  it('waits for the next edge when this one is too close', async () => {
    const edge = nextWindowEdge(START, RULE.windowMs);
    clock.jumpTo(edge - 100);
    const responses = await burstAcrossEdge(cluster, clock, RULE, ['fixed-window'], 'edge-3');
    expect(responses[0]?.at).toBe(edge + RULE.windowMs - BEFORE_EDGE_MS);
  });
});

describe('maxAllowedInAnyWindow', () => {
  const at = (...times: number[]) => times.map((t) => ({ at: t, status: 200 as const }));

  it('counts allowed requests in the busiest window, ignoring 429s', () => {
    expect(maxAllowedInAnyWindow([], 10)).toBe(0);
    expect(maxAllowedInAnyWindow(at(0, 5, 9, 10, 11), 10)).toBe(4);
    expect(maxAllowedInAnyWindow(at(0, 10, 20), 10)).toBe(1);
    expect(maxAllowedInAnyWindow([...at(0, 1), { at: 2, status: 429 }], 10)).toBe(2);
    expect(maxAllowedInAnyWindow(at(20, 0, 15, 5), 10)).toBe(2);
  });
});

describe('SimClock', () => {
  it('keeps whole milliseconds, carrying fractions', () => {
    const c = new SimClock(0);
    c.advance(0.4);
    expect(c.now()).toBe(0);
    c.advance(0.7);
    expect(c.now()).toBe(1);
    c.jumpTo(10);
    expect(c.now()).toBe(10);
    expect(() => {
      c.jumpTo(9);
    }).toThrow(RangeError);
    expect(() => {
      c.advance(-1);
    }).toThrow(RangeError);
  });
});
