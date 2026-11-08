// A stand-in for the 13 Redis commands the rate-limit scripts use, run by wasmoon (Lua 5.4).
// Time is simulated. Values are stored as strings, as Redis stores them.
import { LuaFactory } from 'wasmoon';

class RedisError extends Error {}

// Redis 7 turns a Lua number argument into a string with fpconv_dtoa: the shortest form that
// round-trips, like JS String() for the magnitudes we use.
function arg(v) {
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') return v;
  throw new RedisError(`ERR Lua redis lib command arguments must be strings or integers (${typeof v})`);
}
function int(s) {
  if (!/^-?\d+$/.test(s)) throw new RedisError('ERR value is not an integer or out of range');
  return Number(s);
}
function float(s) {
  if (s === '+inf' || s === 'inf') return Infinity;
  if (s === '-inf') return -Infinity;
  const n = Number(s);
  if (s.trim() === '' || Number.isNaN(n)) throw new RedisError('ERR value is not a valid float');
  return n;
}
function bound(s) {
  return s.startsWith('(') ? { v: float(s.slice(1)), ex: true } : { v: float(s), ex: false };
}
const above = (x, b) => (b.ex ? x > b.v : x >= b.v);
const below = (x, b) => (b.ex ? x < b.v : x <= b.v);
// Redis prints scores with %.17g, then trims: integers print plainly.
const score = (n) => String(n);

export class FakeRedis {
  constructor(now = () => 0) {
    this.now = now; // ms
    this.data = new Map(); // key -> { type, value: Map, expiresAt }
    this.lastPexpire = new Map();
    this.expiry = true;
  }
  entry(key) {
    const e = this.data.get(key);
    if (e && this.expiry && e.expiresAt !== undefined && e.expiresAt <= this.now()) {
      this.data.delete(key);
      return undefined;
    }
    return e;
  }
  typed(key, type) {
    const e = this.entry(key);
    if (e && e.type !== type) {
      throw new RedisError('WRONGTYPE Operation against a key holding the wrong kind of value');
    }
    return e;
  }
  create(key, type) {
    let e = this.typed(key, type);
    if (!e) this.data.set(key, (e = { type, value: new Map(), expiresAt: undefined }));
    return e;
  }
  sorted(e) {
    return [...e.value].sort(([ma, sa], [mb, sb]) => sa - sb || (ma < mb ? -1 : ma > mb ? 1 : 0));
  }
  call(name, ...raw) {
    const a = raw.map(arg);
    const cmd = name.toUpperCase();
    switch (cmd) {
      case 'TIME': {
        const ms = this.now();
        return [String(Math.floor(ms / 1000)), String((ms % 1000) * 1000)];
      }
      case 'TYPE':
        return { ok: this.entry(a[0])?.type ?? 'none' };
      case 'DEL':
        return a.filter((k) => this.entry(k) && this.data.delete(k)).length;
      case 'PEXPIRE': {
        const e = this.entry(a[0]);
        const ms = int(a[1]);
        this.lastPexpire.set(a[0], ms);
        if (!e) return 0;
        if (ms <= 0) this.data.delete(a[0]);
        else e.expiresAt = this.now() + ms;
        return 1;
      }
      case 'HGET':
        return this.typed(a[0], 'hash')?.value.get(a[1]) ?? false;
      case 'HMGET': {
        const e = this.typed(a[0], 'hash');
        return a.slice(1).map((f) => e?.value.get(f) ?? false);
      }
      case 'HSET': {
        const e = this.create(a[0], 'hash');
        let added = 0;
        for (let i = 1; i < a.length; i += 2) {
          if (!e.value.has(a[i])) added++;
          e.value.set(a[i], a[i + 1]);
        }
        return added;
      }
      case 'ZSCORE': {
        const s = this.typed(a[0], 'zset')?.value.get(a[1]);
        return s === undefined ? false : score(s);
      }
      case 'ZADD': {
        const pairs = [];
        for (let i = 1; i < a.length; i += 2) pairs.push([float(a[i]), a[i + 1]]);
        const e = this.create(a[0], 'zset');
        let added = 0;
        for (const [s, m] of pairs) {
          if (!e.value.has(m)) added++;
          e.value.set(m, s);
        }
        return added;
      }
      case 'ZCOUNT': {
        const e = this.typed(a[0], 'zset');
        const [lo, hi] = [bound(a[1]), bound(a[2])];
        return e ? [...e.value.values()].filter((s) => above(s, lo) && below(s, hi)).length : 0;
      }
      case 'ZREMRANGEBYSCORE': {
        const e = this.typed(a[0], 'zset');
        if (!e) return 0;
        const [lo, hi] = [bound(a[1]), bound(a[2])];
        let n = 0;
        for (const [m, s] of [...e.value]) {
          if (above(s, lo) && below(s, hi)) {
            e.value.delete(m);
            n++;
          }
        }
        if (e.value.size === 0) this.data.delete(a[0]);
        return n;
      }
      case 'ZRANGEBYSCORE': {
        const e = this.typed(a[0], 'zset');
        const [lo, hi] = [bound(a[1]), bound(a[2])];
        let withScores = false;
        let offset = 0;
        let count = -1;
        for (let i = 3; i < a.length; i++) {
          const opt = a[i].toUpperCase();
          if (opt === 'WITHSCORES') withScores = true;
          else if (opt === 'LIMIT') {
            offset = int(a[++i]);
            count = int(a[++i]);
          } else throw new RedisError('ERR syntax error');
        }
        let items = e ? this.sorted(e).filter(([, s]) => above(s, lo) && below(s, hi)) : [];
        items = items.slice(offset, count < 0 ? undefined : offset + count);
        return items.flatMap(([m, s]) => (withScores ? [m, score(s)] : [m]));
      }
      case 'ZRANGE': {
        const e = this.typed(a[0], 'zset');
        const withScores = a[3]?.toUpperCase() === 'WITHSCORES';
        if (!e) return [];
        const items = this.sorted(e);
        const n = items.length;
        let start = int(a[1]);
        let stop = int(a[2]);
        if (start < 0) start = Math.max(0, n + start);
        if (stop < 0) stop = n + stop;
        stop = Math.min(stop, n - 1);
        return items.slice(start, stop + 1).flatMap(([m, s]) => (withScores ? [m, score(s)] : [m]));
      }
      default:
        throw new RedisError(`ERR unknown command '${name}' in the stand-in`);
    }
  }
  dump(key) {
    const e = this.entry(key);
    if (!e) return { type: 'none' };
    if (e.type === 'hash') return { type: 'hash', value: Object.fromEntries([...e.value].sort()) };
    return { type: 'zset', value: this.sorted(e).flatMap(([m, s]) => [m, score(s)]) };
  }
}

// Redis turns a Lua number reply into an integer by truncating it.
function reply(v) {
  if (typeof v === 'number') return Math.trunc(v);
  if (Array.isArray(v)) return v.map(reply);
  return v;
}

export async function createRunner(redis) {
  const lua = await new LuaFactory().createEngine();
  lua.global.set('__call', (name, ...args) => redis.call(name, ...args));
  await lua.doString(`redis = { call = function(...) return __call(...) end }`);
  return {
    lua,
    run(source, keys, argv) {
      lua.global.set('KEYS', keys);
      lua.global.set('ARGV', argv);
      return reply(lua.doStringSync(source));
    },
  };
}
