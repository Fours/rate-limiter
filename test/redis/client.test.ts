import { describe, expect, it } from 'vitest';
import {
  assertScriptClient,
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

describe('fromIoredis replies', () => {
  function replying(reply: unknown) {
    const client: IoredisLike = {
      evalsha: () => Promise.resolve(reply),
      eval: () => Promise.resolve(reply),
    };
    return fromIoredis(client);
  }

  it('turns decimal integer strings back into numbers, for stringNumbers: true', async () => {
    expect(await replying(['1', '0', '-3', '12000']).evalsha('s', [], [])).toStrictEqual([
      1, 0, -3, 12_000,
    ]);
    expect(await replying(['1', '4', '60']).eval('s', [], [])).toStrictEqual([1, 4, 60]);
  });

  it('leaves anything else for the reply check to reject', async () => {
    // Found by mutation testing: without the end anchor, "12abc" or "1e3" would be read as numbers.
    const odd = ['12abc', '1e3', '007', '1.5', '', 'x', 5, null];
    expect(await replying(odd).evalsha('s', [], [])).toStrictEqual(odd);
    expect(await replying('OK').evalsha('s', [], [])).toBe('OK');
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
      'fromIoredis: expected a client with evalsha and eval methods. For the other Redis library, use fromNodeRedis.',
    );
  });

  it.each([null, 'redis', 5])('rejects %j with the same message', (value) => {
    expect(() => fromIoredis(value as unknown as IoredisLike)).toThrow(
      'fromIoredis: expected a client with evalsha and eval methods',
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

describe('assertScriptClient', () => {
  const ioredisRaw = {
    evalsha: () => Promise.resolve(),
    eval: () => Promise.resolve(),
    defineCommand: () => undefined,
  };
  const nodeRedisRaw = { evalSha: () => Promise.resolve(), eval: () => Promise.resolve() };

  it('accepts adapted clients, even when the raw client looks like ioredis', () => {
    expect(() => {
      assertScriptClient(fromIoredis(ioredisRaw), 'test');
    }).not.toThrow();
    expect(() => {
      assertScriptClient(fromNodeRedis(nodeRedisRaw), 'test');
    }).not.toThrow();
  });

  it('accepts a hand-written client', () => {
    const own = { evalsha: () => Promise.resolve(), eval: () => Promise.resolve() };
    expect(() => {
      assertScriptClient(own, 'test');
    }).not.toThrow();
  });

  it.each([
    ['a raw ioredis client', ioredisRaw, /looks like an ioredis client.*fromIoredis/],
    ['a raw node-redis client', nodeRedisRaw, /looks like a node-redis client.*fromNodeRedis/],
    ['null', null, /must be a RedisScriptClient/],
    ['a URL string', 'redis://localhost', /must be a RedisScriptClient/],
    ['an object without the methods', { eval: () => Promise.resolve() }, /evalsha and eval/],
  ])('rejects %s, naming the caller', (_label, value, message) => {
    expect(() => {
      assertScriptClient(value, 'createRedisTokenBucket');
    }).toThrow(message);
    expect(() => {
      assertScriptClient(value, 'createRedisTokenBucket');
    }).toThrow(/^createRedisTokenBucket: /);
  });
});
