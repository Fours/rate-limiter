import { describe, expect, it } from 'vitest';
import {
  fromIoredis,
  fromNodeRedis,
  type IoredisLike,
  type NodeRedisLike,
} from '../../src/redis/client.js';

describe('fromIoredis', () => {
  it('passes the key count, then keys, then args', async () => {
    const calls: unknown[][] = [];
    const client: IoredisLike = {
      evalsha: (...a) => (calls.push(['evalsha', ...a]), Promise.resolve('sha-reply')),
      eval: (...a) => (calls.push(['eval', ...a]), Promise.resolve('eval-reply')),
    };
    const adapted = fromIoredis(client);
    expect(await adapted.evalsha('abc', ['k1', 'k2'], ['a1'])).toBe('sha-reply');
    expect(await adapted.eval('return 1', ['k1'], ['a1', 'a2'])).toBe('eval-reply');
    expect(calls).toStrictEqual([
      ['evalsha', 'abc', 2, 'k1', 'k2', 'a1'],
      ['eval', 'return 1', 1, 'k1', 'a1', 'a2'],
    ]);
  });
});

describe('fromNodeRedis', () => {
  it('passes keys and args as an options object', async () => {
    const calls: unknown[][] = [];
    const client: NodeRedisLike = {
      evalSha: (...a) => (calls.push(['evalSha', ...a]), Promise.resolve('sha-reply')),
      eval: (...a) => (calls.push(['eval', ...a]), Promise.resolve('eval-reply')),
    };
    const adapted = fromNodeRedis(client);
    expect(await adapted.evalsha('abc', ['k1'], ['a1'])).toBe('sha-reply');
    expect(await adapted.eval('return 1', ['k1'], ['a1'])).toBe('eval-reply');
    expect(calls).toStrictEqual([
      ['evalSha', 'abc', { keys: ['k1'], arguments: ['a1'] }],
      ['eval', 'return 1', { keys: ['k1'], arguments: ['a1'] }],
    ]);
  });
});

describe('adapter checks at startup', () => {
  const ioredisShaped = { evalsha: () => Promise.resolve(), eval: () => Promise.resolve() };
  const nodeRedisShaped = { evalSha: () => Promise.resolve(), eval: () => Promise.resolve() };

  it('points to fromNodeRedis when given a node-redis client', () => {
    expect(() => fromIoredis(nodeRedisShaped as unknown as IoredisLike)).toThrow(
      /fromIoredis.*use fromNodeRedis/,
    );
  });

  it('points to fromIoredis when given an ioredis client', () => {
    expect(() => fromNodeRedis(ioredisShaped as unknown as NodeRedisLike)).toThrow(
      /fromNodeRedis.*use fromIoredis/,
    );
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a URL string', 'redis://localhost:6379'],
    ['an empty object', {}],
  ])('rejects %s', (_label, value) => {
    expect(() => fromIoredis(value as unknown as IoredisLike)).toThrow(TypeError);
    expect(() => fromNodeRedis(value as unknown as NodeRedisLike)).toThrow(TypeError);
  });
});
