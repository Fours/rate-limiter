import { beforeEach, describe, expect, it } from 'vitest';
import { RedisError, StandInRedis } from '../../demo/src/redis/stand-in.ts';
import { FakeClock } from '../helpers/fake-clock.js';

// Each command as Redis 7 answers it. The parity test (test/integration/demo-parity.test.ts)
// compares whole script runs with real Redis; these pin each command down on its own, including
// paths the scripts never take today.

let clock: FakeClock;
let redis: StandInRedis;

beforeEach(() => {
  clock = new FakeClock(1_700_000_000_123);
  redis = new StandInRedis(() => clock.now());
});

const wrongType = /^WRONGTYPE /;

describe('TIME', () => {
  it('replies seconds and microseconds of simulated time, as strings', () => {
    expect(redis.call('TIME')).toEqual(['1700000000', '123000']);
    clock.advance(1_877);
    expect(redis.call('time')).toEqual(['1700000002', '0']);
  });
});

describe('TYPE', () => {
  it('replies a status for each type, and none without a key', () => {
    expect(redis.call('TYPE', 'k')).toEqual({ ok: 'none' });
    redis.call('HSET', 'h', 'f', 'v');
    redis.call('ZADD', 'z', 1, 'm');
    expect(redis.call('TYPE', 'h')).toEqual({ ok: 'hash' });
    expect(redis.call('TYPE', 'z')).toEqual({ ok: 'zset' });
  });
});

describe('DEL', () => {
  it('replies how many keys it deleted', () => {
    redis.call('HSET', 'a', 'f', 'v');
    redis.call('ZADD', 'b', 1, 'm');
    expect(redis.call('DEL', 'a', 'b', 'missing')).toBe(2);
    expect(redis.dump('a')).toEqual({ type: 'none' });
    expect(redis.call('DEL', 'a')).toBe(0);
  });
});

describe('PEXPIRE and expiry on simulated time', () => {
  it('expires a key exactly when its time comes, and not before', () => {
    redis.call('HSET', 'k', 'f', 'v');
    expect(redis.call('PEXPIRE', 'k', 1_000)).toBe(1);
    expect(redis.pttl('k')).toBe(1_000);
    clock.advance(999);
    expect(redis.call('HGET', 'k', 'f')).toBe('v');
    clock.advance(1);
    expect(redis.call('HGET', 'k', 'f')).toBe(false);
    expect(redis.call('TYPE', 'k')).toEqual({ ok: 'none' });
    expect(redis.keys()).toEqual([]);
  });

  it('replies 0 for a missing key', () => {
    expect(redis.call('PEXPIRE', 'k', 1_000)).toBe(0);
  });

  it('deletes the key at once for 0 or less', () => {
    redis.call('HSET', 'a', 'f', 'v');
    redis.call('HSET', 'b', 'f', 'v');
    expect(redis.call('PEXPIRE', 'a', 0)).toBe(1);
    expect(redis.call('PEXPIRE', 'b', -5)).toBe(1);
    expect(redis.keys()).toEqual([]);
  });

  it('sets a new time when called again', () => {
    redis.call('HSET', 'k', 'f', 'v');
    redis.call('PEXPIRE', 'k', 100);
    clock.advance(50);
    redis.call('PEXPIRE', 'k', 100);
    clock.advance(99);
    expect(redis.pttl('k')).toBe(1);
  });

  it('keeps the expiry when the key is written to again', () => {
    redis.call('HSET', 'k', 'f', 'v');
    redis.call('PEXPIRE', 'k', 100);
    redis.call('HSET', 'k', 'g', 'w');
    expect(redis.pttl('k')).toBe(100);
  });

  it('starts a written key afresh, with no expiry, once the old one expired', () => {
    redis.call('HSET', 'k', 'f', 'v');
    redis.call('PEXPIRE', 'k', 100);
    clock.advance(100);
    redis.call('HSET', 'k', 'g', 'w');
    expect(redis.dump('k')).toEqual({ type: 'hash', value: { g: 'w' } });
    expect(redis.pttl('k')).toBe(-1);
  });

  it('never expires keys with expiry turned off, for the parity test', () => {
    redis.expiry = false;
    redis.call('HSET', 'k', 'f', 'v');
    redis.call('PEXPIRE', 'k', 100);
    clock.advance(1_000);
    expect(redis.call('HGET', 'k', 'f')).toBe('v');
  });

  it('records the last PEXPIRE each key was given', () => {
    redis.call('PEXPIRE', 'k', 250);
    expect(redis.lastPexpire.get('k')).toBe(250);
  });

  it('refuses a time that is not an integer', () => {
    redis.call('HSET', 'k', 'f', 'v');
    expect(() => redis.call('PEXPIRE', 'k', 1.5)).toThrow(/not an integer/);
  });

  it('replies -2 from pttl without a key, and -1 without an expiry', () => {
    expect(redis.pttl('k')).toBe(-2);
    redis.call('HSET', 'k', 'f', 'v');
    expect(redis.pttl('k')).toBe(-1);
  });
});

describe('hashes: HSET, HGET, HMGET, HDEL', () => {
  it('HSET replies how many fields are new, and stores strings', () => {
    expect(redis.call('HSET', 'k', 'a', 1, 'b', 2.5)).toBe(2);
    expect(redis.call('HSET', 'k', 'a', 3, 'c', 4)).toBe(1);
    expect(redis.dump('k')).toEqual({ type: 'hash', value: { a: '3', b: '2.5', c: '4' } });
  });

  it('writes numbers the shortest way that reads back exactly, as Redis 7 does', () => {
    redis.call('HSET', 'k', 'a', 1e21, 'b', 0.1 + 0.2, 'c', 2 ** 53);
    expect(redis.call('HMGET', 'k', 'a', 'b', 'c')).toEqual([
      '1e+21',
      '0.30000000000000004',
      '9007199254740992',
    ]);
  });

  it('HGET and HMGET reply false (nil) for missing fields and keys', () => {
    redis.call('HSET', 'k', 'a', 'x');
    expect(redis.call('HGET', 'k', 'missing')).toBe(false);
    expect(redis.call('HGET', 'missing', 'a')).toBe(false);
    expect(redis.call('HMGET', 'k', 'a', 'missing')).toEqual(['x', false]);
    expect(redis.call('HMGET', 'missing', 'a', 'b')).toEqual([false, false]);
  });

  it('HDEL replies how many fields it removed, and deletes an emptied key', () => {
    redis.call('HSET', 'k', 'a', 1, 'b', 2);
    expect(redis.call('HDEL', 'k', 'a', 'missing')).toBe(1);
    expect(redis.dump('k')).toEqual({ type: 'hash', value: { b: '2' } });
    expect(redis.call('HDEL', 'k', 'b')).toBe(1);
    expect(redis.call('TYPE', 'k')).toEqual({ ok: 'none' });
    expect(redis.call('HDEL', 'missing', 'a')).toBe(0);
  });

  it('refuses a wrong number of arguments', () => {
    expect(() => redis.call('HSET', 'k', 'a')).toThrow(/wrong number of arguments/);
    expect(() => redis.call('HGET', 'k')).toThrow(/wrong number of arguments/);
    expect(() => redis.call('HMGET', 'k')).toThrow(/wrong number of arguments/);
    expect(() => redis.call('HDEL', 'k')).toThrow(/wrong number of arguments/);
  });
});

describe('sorted sets: ZADD, ZSCORE, ZCOUNT, ZREMRANGEBYSCORE', () => {
  it('ZADD replies how many members are new, and updates scores', () => {
    expect(redis.call('ZADD', 'k', 1, 'a', 2, 'b')).toBe(2);
    expect(redis.call('ZADD', 'k', 5, 'a', 3, 'c')).toBe(1);
    expect(redis.dump('k')).toEqual({ type: 'zset', value: ['b', '2', 'c', '3', 'a', '5'] });
  });

  it('ZADD accepts scores as strings, and changes nothing if any is not a number', () => {
    redis.call('ZADD', 'k', '1700000000000', 'a');
    expect(() => redis.call('ZADD', 'k', 2, 'b', 'nope', 'c')).toThrow(/not a valid float/);
    expect(redis.dump('k')).toEqual({ type: 'zset', value: ['a', '1700000000000'] });
  });

  it('ZSCORE replies the score as a string, or false', () => {
    redis.call('ZADD', 'k', 1700000000123, 'a');
    expect(redis.call('ZSCORE', 'k', 'a')).toBe('1700000000123');
    expect(redis.call('ZSCORE', 'k', 'missing')).toBe(false);
    expect(redis.call('ZSCORE', 'missing', 'a')).toBe(false);
  });

  it('ZCOUNT counts within inclusive, exclusive and infinite bounds', () => {
    redis.call('ZADD', 'k', 1, 'a', 2, 'b', 3, 'c');
    expect(redis.call('ZCOUNT', 'k', 1, 3)).toBe(3);
    expect(redis.call('ZCOUNT', 'k', '(1', 3)).toBe(2);
    expect(redis.call('ZCOUNT', 'k', 1, '(3')).toBe(2);
    expect(redis.call('ZCOUNT', 'k', '-inf', '+inf')).toBe(3);
    expect(redis.call('ZCOUNT', 'k', '(2', 'inf')).toBe(1);
    expect(redis.call('ZCOUNT', 'missing', '-inf', '+inf')).toBe(0);
    expect(() => redis.call('ZCOUNT', 'k', 'x', 1)).toThrow(/not a valid float/);
  });

  it('ZREMRANGEBYSCORE removes within bounds, replies how many, and deletes an emptied key', () => {
    redis.call('ZADD', 'k', 1, 'a', 2, 'b', 3, 'c');
    expect(redis.call('ZREMRANGEBYSCORE', 'k', '-inf', '(2')).toBe(1);
    expect(redis.dump('k')).toEqual({ type: 'zset', value: ['b', '2', 'c', '3'] });
    expect(redis.call('ZREMRANGEBYSCORE', 'k', 2, 3)).toBe(2);
    expect(redis.call('TYPE', 'k')).toEqual({ ok: 'none' });
    expect(redis.call('ZREMRANGEBYSCORE', 'missing', 0, 1)).toBe(0);
  });
});

describe('sorted sets: ZRANGEBYSCORE and ZRANGE', () => {
  beforeEach(() => {
    // Ties order by member, byte by byte.
    redis.call('ZADD', 'k', 2, 'b', 1, 'z', 2, 'a', 3, 'c');
  });

  it('orders by score, then ties by member', () => {
    expect(redis.call('ZRANGE', 'k', 0, -1)).toEqual(['z', 'a', 'b', 'c']);
  });

  it('ZRANGEBYSCORE with WITHSCORES and LIMIT', () => {
    expect(redis.call('ZRANGEBYSCORE', 'k', 2, '+inf')).toEqual(['a', 'b', 'c']);
    expect(redis.call('ZRANGEBYSCORE', 'k', '(1', 2, 'WITHSCORES')).toEqual(['a', '2', 'b', '2']);
    expect(redis.call('ZRANGEBYSCORE', 'k', '-inf', '+inf', 'WITHSCORES', 'LIMIT', 1, 2)).toEqual([
      'a',
      '2',
      'b',
      '2',
    ]);
    expect(redis.call('ZRANGEBYSCORE', 'k', '-inf', '+inf', 'limit', 3, -1)).toEqual(['c']);
    expect(redis.call('ZRANGEBYSCORE', 'k', '-inf', '+inf', 'LIMIT', 9, 1)).toEqual([]);
    expect(redis.call('ZRANGEBYSCORE', 'missing', '-inf', '+inf')).toEqual([]);
    expect(() => redis.call('ZRANGEBYSCORE', 'k', 0, 1, 'NOPE')).toThrow(/syntax error/);
  });

  it('ZRANGE with negative indexes and WITHSCORES', () => {
    expect(redis.call('ZRANGE', 'k', -1, -1, 'WITHSCORES')).toEqual(['c', '3']);
    expect(redis.call('ZRANGE', 'k', -2, -1)).toEqual(['b', 'c']);
    expect(redis.call('ZRANGE', 'k', -100, 1)).toEqual(['z', 'a']);
    expect(redis.call('ZRANGE', 'k', 1, 100)).toEqual(['a', 'b', 'c']);
    expect(redis.call('ZRANGE', 'k', 3, 1)).toEqual([]);
    expect(redis.call('ZRANGE', 'k', 9, 10)).toEqual([]);
    expect(redis.call('ZRANGE', 'missing', -1, -1, 'WITHSCORES')).toEqual([]);
    expect(() => redis.call('ZRANGE', 'k', 0, -1, 'NOPE')).toThrow(/syntax error/);
  });
});

describe('WRONGTYPE', () => {
  it('a hash command on a sorted set, and the other way round, fails as in Redis', () => {
    redis.call('ZADD', 'z', 1, 'm');
    redis.call('HSET', 'h', 'f', 'v');
    for (const call of [
      () => redis.call('HGET', 'z', 'f'),
      () => redis.call('HMGET', 'z', 'f'),
      () => redis.call('HSET', 'z', 'f', 'v'),
      () => redis.call('HDEL', 'z', 'f'),
      () => redis.call('ZADD', 'h', 1, 'm'),
      () => redis.call('ZSCORE', 'h', 'm'),
      () => redis.call('ZCOUNT', 'h', 0, 1),
      () => redis.call('ZREMRANGEBYSCORE', 'h', 0, 1),
      () => redis.call('ZRANGEBYSCORE', 'h', 0, 1),
      () => redis.call('ZRANGE', 'h', 0, -1),
    ]) {
      expect(call).toThrow(RedisError);
      expect(call).toThrow(wrongType);
    }
    // Commands for any type still work.
    expect(redis.call('TYPE', 'z')).toEqual({ ok: 'zset' });
    expect(redis.call('PEXPIRE', 'z', 10)).toBe(1);
    expect(redis.call('DEL', 'z', 'h')).toBe(2);
  });

  it('an expired key of the other type is no longer in the way', () => {
    redis.call('ZADD', 'k', 1, 'm');
    redis.call('PEXPIRE', 'k', 10);
    clock.advance(10);
    expect(redis.call('HSET', 'k', 'f', 'v')).toBe(1);
  });
});

describe('arguments and commands', () => {
  it('refuses arguments that are not strings or numbers, as Redis does', () => {
    expect(() => redis.call('HSET', 'k', 'f', true)).toThrow(/must be strings or integers/);
  });

  it('refuses a command the stand-in does not implement', () => {
    expect(() => redis.call('INCR', 'k')).toThrow(/unknown command 'INCR'/);
  });
});

describe('going down and coming back', () => {
  it('fails every command while down', () => {
    redis.setDown(true);
    expect(redis.down).toBe(true);
    expect(() => redis.call('TIME')).toThrow(/down/);
  });

  it('keeps the data through a restart, and empties the script cache', () => {
    redis.call('HSET', 'k', 'f', 'v');
    redis.scripts.set('sha', 'return 1');
    redis.setDown(true);
    expect(redis.scripts.size).toBe(1);
    redis.setDown(false);
    expect(redis.scripts.size).toBe(0);
    expect(redis.call('HGET', 'k', 'f')).toBe('v');
  });

  it('keeps the script cache when set down twice or up while up', () => {
    redis.scripts.set('sha', 'return 1');
    redis.setDown(false);
    expect(redis.scripts.size).toBe(1);
  });

  it('clear empties every key', () => {
    redis.call('HSET', 'a', 'f', 'v');
    redis.call('ZADD', 'b', 1, 'm');
    expect(redis.keys()).toEqual(['a', 'b']);
    redis.clear();
    expect(redis.keys()).toEqual([]);
  });
});
