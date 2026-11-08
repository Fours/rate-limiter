import { describe, expect, it } from 'vitest';
import type { RedisScriptClient } from '../../src/redis/client.js';
import { defineScript, parseDecision, runScript } from '../../src/redis/scripts.js';

const script = defineScript('return {1, 2, 3}');

type Call = [method: 'evalsha' | 'eval', first: string, keys: string[], args: string[]];

/** A client that records each call and answers from a queue: a value to return, or an Error to throw. */
function fakeClient(...answers: unknown[]): { client: RedisScriptClient; calls: Call[] } {
  const calls: Call[] = [];
  const answer = (): Promise<unknown> => {
    const next = answers.shift();
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  };
  return {
    calls,
    client: {
      evalsha: (sha, keys, args) => (calls.push(['evalsha', sha, keys, args]), answer()),
      eval: (source, keys, args) => (calls.push(['eval', source, keys, args]), answer()),
    },
  };
}

const noScript = () => new Error('NOSCRIPT No matching script. Please use EVAL.');

describe('defineScript', () => {
  it('computes the SHA-1 Redis uses as the script id', () => {
    // Computed outside Node: printf '%s' 'return {1, 2, 3}' | shasum
    expect(script.sha).toBe('81f2555369253b25a7dc3a322b3ee4a6a0516294');
  });
});

describe('runScript', () => {
  it('uses EVALSHA when the script is cached', async () => {
    const { client, calls } = fakeClient([1, 2, 3]);
    expect(await runScript(client, script, ['k'], ['a'])).toStrictEqual([1, 2, 3]);
    expect(calls).toStrictEqual([['evalsha', script.sha, ['k'], ['a']]]);
  });

  it('retries once with EVAL on NOSCRIPT, with the same keys and args', async () => {
    const { client, calls } = fakeClient(noScript(), [0, 0, 5]);
    expect(await runScript(client, script, ['k'], ['a', 'b'])).toStrictEqual([0, 0, 5]);
    expect(calls).toStrictEqual([
      ['evalsha', script.sha, ['k'], ['a', 'b']],
      ['eval', script.source, ['k'], ['a', 'b']],
    ]);
  });

  it('rethrows other errors unchanged, without retrying', async () => {
    const failure = new Error('ERR boom');
    const { client, calls } = fakeClient(failure);
    await expect(runScript(client, script, ['k'], [])).rejects.toBe(failure);
    expect(calls).toHaveLength(1);
  });

  it('rethrows an EVAL failure after NOSCRIPT, and stops there', async () => {
    const failure = new Error('NOSCRIPT again');
    const { client, calls } = fakeClient(noScript(), failure);
    await expect(runScript(client, script, ['k'], [])).rejects.toBe(failure);
    expect(calls.map(([method]) => method)).toStrictEqual(['evalsha', 'eval']);
  });

  it('only treats errors whose message starts with NOSCRIPT as a missing script', async () => {
    const failure = new Error('ERR something NOSCRIPT-ish');
    const { client, calls } = fakeClient(failure);
    await expect(runScript(client, script, ['k'], [])).rejects.toBe(failure);
    expect(calls).toHaveLength(1);
  });
});

describe('parseDecision', () => {
  it.each([
    [[1, 4, 2_000], { allowed: true, remaining: 4, resetMs: 2_000 }],
    [[0, 0, 0], { allowed: false, remaining: 0, resetMs: 0 }],
  ])('turns %j into a Decision', (reply, decision) => {
    expect(parseDecision(reply)).toStrictEqual(decision);
  });

  it.each([
    ['not an array', 'OK'],
    ['null', null],
    ['undefined', undefined],
    ['too short, as when Lua returns nil inside the table', [1, 2]],
    ['too long', [1, 2, 3, 4]],
    ['a number sent as a string', [1, '2', 3]],
    ['a fraction', [1, 2.5, 3]],
    ['a negative value', [1, 2, -1]],
    ['an unsafe integer', [1, 2, 2 ** 53]],
    ['allowed of 2', [2, 0, 0]],
  ])('throws for %s', (_label, reply) => {
    expect(() => parseDecision(reply)).toThrow(/Unexpected reply from a rate-limit script/);
  });

  it('shows the reply as JSON, so a string reads differently from a number', () => {
    expect(() => parseDecision([1, '2', 3])).toThrow(/got \[1,"2",3\]$/);
    expect(() => parseDecision(undefined)).toThrow(/got undefined$/);
  });

  it('still describes a reply JSON.stringify cannot handle, such as BigInts', () => {
    // node-redis can be configured to map integers to BigInt, which JSON.stringify rejects.
    expect(() => parseDecision([1n, 2n, 3n])).toThrow(/got 1,2,3/);
  });
});
