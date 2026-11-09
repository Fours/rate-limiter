import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fromIoredis, fromNodeRedis, type RedisScriptClient } from '../../src/redis/client.js';
import { defineScript } from '../../src/algorithms/redis/load-script.js';
import { parseDecision, runScript } from '../../src/redis/scripts.js';
import { connectIoredis, connectNodeRedis } from './helpers/redis.js';

/** Wraps a real client and records which method each call went through. */
function spy(inner: RedisScriptClient): { client: RedisScriptClient; methods: string[] } {
  const methods: string[] = [];
  return {
    methods,
    client: {
      evalsha: (sha, keys, args) => (methods.push('evalsha'), inner.evalsha(sha, keys, args)),
      eval: (source, keys, args) => (methods.push('eval'), inner.eval(source, keys, args)),
    },
  };
}

const echo = defineScript('return {KEYS[1], KEYS[2], ARGV[1], ARGV[2], #KEYS, #ARGV}');
const decision = defineScript('return {1, tonumber(ARGV[1]), 1500}');
const failing = defineScript('return redis.error_reply("ERR boom")');

let ioredis: Redis;
let nodeRedis: Awaited<ReturnType<typeof connectNodeRedis>>;

beforeAll(async () => {
  ioredis = await connectIoredis();
  nodeRedis = await connectNodeRedis();
});

afterAll(async () => {
  await ioredis.quit();
  await nodeRedis.quit();
});

// Both adapters must behave identically against a real Redis.
describe.each([
  ['ioredis', () => fromIoredis(ioredis)],
  ['node-redis', () => fromNodeRedis(nodeRedis)],
])('script runner through %s', (_name, adapt) => {
  it('delivers keys and args in order', async () => {
    const reply = await runScript(adapt(), echo, ['k1', 'k2'], ['a1', 'a2']);
    expect(reply).toStrictEqual(['k1', 'k2', 'a1', 'a2', 2, 2]);
  });

  it('accepts replies from ioredis with stringNumbers: true', async () => {
    // Found by the 1.0 correctness review: with this setting, every check failed at request
    // time, so the limiter ran on the per-instance fallback for good.
    const strings = await connectIoredis({ stringNumbers: true });
    try {
      const reply = await runScript(fromIoredis(strings), decision, ['k'], ['7']);
      expect(parseDecision(reply)).toStrictEqual({ allowed: true, remaining: 7, resetMs: 1_500 });
    } finally {
      await strings.quit();
    }
  });

  it('returns a reply parseDecision accepts', async () => {
    const reply = await runScript(adapt(), decision, ['k'], ['7']);
    expect(parseDecision(reply)).toStrictEqual({ allowed: true, remaining: 7, resetMs: 1_500 });
  });

  it('uses EVALSHA alone when the script is cached', async () => {
    await ioredis.script('LOAD', echo.source);
    const { client, methods } = spy(adapt());
    await runScript(client, echo, ['k1', 'k2'], ['a1', 'a2']);
    expect(methods).toStrictEqual(['evalsha']);
  });

  it('falls back to EVAL once after SCRIPT FLUSH, then is cached again', async () => {
    await ioredis.script('FLUSH');
    const { client, methods } = spy(adapt());
    const reply = await runScript(client, echo, ['k1', 'k2'], ['a1', 'a2']);
    expect(reply).toStrictEqual(['k1', 'k2', 'a1', 'a2', 2, 2]);
    expect(methods).toStrictEqual(['evalsha', 'eval']);

    methods.length = 0;
    await runScript(client, echo, ['k1', 'k2'], ['a1', 'a2']);
    expect(methods).toStrictEqual(['evalsha']);
  });

  it('passes a script error through without retrying', async () => {
    // Cache it first, so the error comes from running the script, not from NOSCRIPT.
    await ioredis.script('LOAD', failing.source);
    const { client, methods } = spy(adapt());
    await expect(runScript(client, failing, ['k'], [])).rejects.toThrow('ERR boom');
    expect(methods).toStrictEqual(['evalsha']);
  });
});
