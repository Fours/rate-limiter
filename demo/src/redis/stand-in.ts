// A stand-in for the Redis the rate-limit scripts talk to, so the demo can run the shipped Lua in
// the browser (decision 0024). It implements only the 14 commands the scripts call, the way Redis 7
// does, on simulated time. test/integration/demo-parity.test.ts runs it against real Redis.

/** An error as Redis would reply with it: the message starts with its code, such as WRONGTYPE. */
export class RedisError extends Error {
  override name = 'RedisError';
}

/** What a Redis command can reply to a script with. `false` is Redis's nil, as Lua sees it. */
export type CommandReply = number | string | false | CommandReply[] | { ok: string };

type Entry =
  | { type: 'hash'; value: Map<string, string>; expiresAt: number | undefined }
  | { type: 'zset'; value: Map<string, number>; expiresAt: number | undefined };

/** A key's whole state, in a fixed order, to compare with what Redis holds. */
export type Dump =
  | { type: 'none' }
  | { type: 'hash'; value: Record<string, string> }
  | { type: 'zset'; value: string[] };

/** A score bound in ZCOUNT and friends: `5`, an exclusive `(5`, or `-inf` and `+inf`. */
interface Bound {
  readonly value: number;
  readonly exclusive: boolean;
}

// Redis turns a Lua number argument into a string the shortest way that round-trips
// (fpconv_dtoa), which for the numbers the scripts send is what JS String() gives. The probe
// behind 0024 checked this, and the parity test keeps checking it.
function argument(value: unknown): string {
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return value;
  throw new RedisError('ERR Lua redis lib command arguments must be strings or integers');
}

function integer(text: string): number {
  if (!/^-?\d+$/.test(text)) throw new RedisError('ERR value is not an integer or out of range');
  return Number(text);
}

function float(text: string): number {
  if (text === '+inf' || text === 'inf') return Infinity;
  if (text === '-inf') return -Infinity;
  const value = Number(text);
  if (text.trim() === '' || Number.isNaN(value)) {
    throw new RedisError('ERR value is not a valid float');
  }
  return value;
}

function bound(text: string): Bound {
  return text.startsWith('(')
    ? { value: float(text.slice(1)), exclusive: true }
    : { value: float(text), exclusive: false };
}

const above = (score: number, b: Bound) => (b.exclusive ? score > b.value : score >= b.value);
const below = (score: number, b: Bound) => (b.exclusive ? score < b.value : score <= b.value);
const within = (score: number, lo: Bound, hi: Bound) => above(score, lo) && below(score, hi);

// Redis prints a score with %.17g, trimmed, so whole numbers print plainly, as String() does.
const formatScore = (score: number) => String(score);

const wrongType = () =>
  new RedisError('WRONGTYPE Operation against a key holding the wrong kind of value');

/** Option arguments, which Redis matches in any case. */
const option = (text: string | undefined) => text?.toUpperCase();

export class StandInRedis {
  private readonly data = new Map<string, Entry>();
  /** Scripts Redis has cached, by SHA-1, for EVALSHA. A restart empties it, as in Redis. */
  readonly scripts = new Map<string, string>();
  /**
   * The last PEXPIRE each key was given, for the parity test to compare with PTTL. Cleared by
   * whoever reads it.
   */
  readonly lastPexpire = new Map<string, number>();
  /** Whether keys expire. Only the parity test turns it off, since its real side PERSISTs. */
  expiry = true;
  private isDown = false;

  /** @param now the simulated time in ms, which TIME and expiry read. */
  constructor(private readonly now: () => number) {}

  /** Whether Redis is down: while it is, every command fails, as if the connection were refused. */
  get down(): boolean {
    return this.isDown;
  }

  /**
   * Takes Redis down, or brings it back. Coming back is a restart: the data stays, as with
   * persistence on, but the script cache is empty, so the first EVALSHA gets NOSCRIPT.
   */
  setDown(down: boolean): void {
    if (this.isDown && !down) this.scripts.clear();
    this.isDown = down;
  }

  /** Runs one command, as a script's redis.call would. Throws a RedisError as Redis replies one. */
  call(name: string, ...raw: unknown[]): CommandReply {
    if (this.isDown) throw new RedisError('ERR the stand-in Redis is down');
    const a = raw.map(argument);
    const at = (i: number): string => {
      const value = a[i];
      if (value === undefined) {
        throw new RedisError(`ERR wrong number of arguments for '${name.toLowerCase()}' command`);
      }
      return value;
    };
    switch (name.toUpperCase()) {
      case 'TIME': {
        const ms = this.now();
        return [String(Math.floor(ms / 1000)), String((ms % 1000) * 1000)];
      }
      case 'TYPE':
        return { ok: this.entry(at(0))?.type ?? 'none' };
      case 'DEL':
        return a.filter((key) => this.entry(key) !== undefined && this.data.delete(key)).length;
      case 'PEXPIRE': {
        const key = at(0);
        const ms = integer(at(1));
        this.lastPexpire.set(key, ms);
        const entry = this.entry(key);
        if (entry === undefined) return 0;
        if (ms <= 0) this.data.delete(key);
        else entry.expiresAt = this.now() + ms;
        return 1;
      }
      case 'HGET': {
        const [key, field] = [at(0), at(1)];
        return this.hash(key)?.get(field) ?? false;
      }
      case 'HMGET': {
        at(1);
        const hash = this.hash(at(0));
        return a.slice(1).map((field) => hash?.get(field) ?? false);
      }
      case 'HSET': {
        if (a.length < 3 || a.length % 2 === 0) at(a.length + 1);
        const hash = this.createHash(at(0));
        let added = 0;
        for (let i = 1; i < a.length; i += 2) {
          if (!hash.has(at(i))) added++;
          hash.set(at(i), at(i + 1));
        }
        return added;
      }
      case 'HDEL': {
        at(1);
        const key = at(0);
        const hash = this.hash(key);
        if (hash === undefined) return 0;
        const removed = a.slice(1).filter((field) => hash.delete(field)).length;
        if (hash.size === 0) this.data.delete(key);
        return removed;
      }
      case 'ZSCORE': {
        const [key, member] = [at(0), at(1)];
        const score = this.zset(key)?.get(member);
        return score === undefined ? false : formatScore(score);
      }
      case 'ZADD': {
        if (a.length < 3 || a.length % 2 === 0) at(a.length + 1);
        // Every score is parsed before anything changes, as Redis does.
        const pairs: [number, string][] = [];
        for (let i = 1; i < a.length; i += 2) pairs.push([float(at(i)), at(i + 1)]);
        const zset = this.createZset(at(0));
        let added = 0;
        for (const [score, member] of pairs) {
          if (!zset.has(member)) added++;
          zset.set(member, score);
        }
        return added;
      }
      case 'ZCOUNT': {
        const [lo, hi] = [bound(at(1)), bound(at(2))];
        const zset = this.zset(at(0));
        return zset === undefined ? 0 : [...zset.values()].filter((s) => within(s, lo, hi)).length;
      }
      case 'ZREMRANGEBYSCORE': {
        const [lo, hi] = [bound(at(1)), bound(at(2))];
        const key = at(0);
        const zset = this.zset(key);
        if (zset === undefined) return 0;
        let removed = 0;
        for (const [member, score] of [...zset]) {
          if (within(score, lo, hi)) {
            zset.delete(member);
            removed++;
          }
        }
        if (zset.size === 0) this.data.delete(key);
        return removed;
      }
      case 'ZRANGEBYSCORE': {
        const [lo, hi] = [bound(at(1)), bound(at(2))];
        let withScores = false;
        let offset = 0;
        let count = -1;
        for (let i = 3; i < a.length; i++) {
          const opt = option(a[i]);
          if (opt === 'WITHSCORES') withScores = true;
          else if (opt === 'LIMIT') {
            offset = integer(at(i + 1));
            count = integer(at(i + 2));
            i += 2;
          } else throw new RedisError('ERR syntax error');
        }
        const zset = this.zset(at(0));
        if (zset === undefined || offset < 0) return [];
        const items = sorted(zset).filter(([, score]) => within(score, lo, hi));
        const page = items.slice(offset, count < 0 ? undefined : offset + count);
        return page.flatMap(([member, score]) =>
          withScores ? [member, formatScore(score)] : [member],
        );
      }
      case 'ZRANGE': {
        let start = integer(at(1));
        let stop = integer(at(2));
        const extra = a.slice(3);
        if (extra.length > 1 || (extra.length === 1 && option(extra[0]) !== 'WITHSCORES')) {
          throw new RedisError('ERR syntax error');
        }
        const withScores = extra.length === 1;
        const zset = this.zset(at(0));
        if (zset === undefined) return [];
        const items = sorted(zset);
        const n = items.length;
        if (start < 0) start = Math.max(0, n + start);
        if (stop < 0) stop = n + stop;
        stop = Math.min(stop, n - 1);
        if (start > stop) return [];
        return items
          .slice(start, stop + 1)
          .flatMap(([member, score]) => (withScores ? [member, formatScore(score)] : [member]));
      }
      default:
        throw new RedisError(`ERR unknown command '${name}', which the stand-in doesn't implement`);
    }
  }

  /** A key's whole state, as HGETALL (sorted by field) or ZRANGE … WITHSCORES would show it. */
  dump(key: string): Dump {
    const entry = this.entry(key);
    if (entry === undefined) return { type: 'none' };
    if (entry.type === 'hash') {
      return { type: 'hash', value: Object.fromEntries([...entry.value].sort()) };
    }
    return {
      type: 'zset',
      value: sorted(entry.value).flatMap(([member, score]) => [member, formatScore(score)]),
    };
  }

  /** Every key that hasn't expired, for the demo to show what Redis holds. */
  keys(): string[] {
    return [...this.data.keys()].filter((key) => this.entry(key) !== undefined).sort();
  }

  /** How long until `key` expires, in ms, as PTTL replies: -2 with no key, -1 with no expiry. */
  pttl(key: string): number {
    const entry = this.entry(key);
    if (entry === undefined) return -2;
    return entry.expiresAt === undefined ? -1 : entry.expiresAt - this.now();
  }

  /** Empties every key, like FLUSHALL. Only for the demo's own stand-in, never a real Redis. */
  clear(): void {
    this.data.clear();
  }

  // Expired keys are removed when next touched, as Redis does lazily.
  private entry(key: string): Entry | undefined {
    const entry = this.data.get(key);
    if (
      entry !== undefined &&
      this.expiry &&
      entry.expiresAt !== undefined &&
      entry.expiresAt <= this.now()
    ) {
      this.data.delete(key);
      return undefined;
    }
    return entry;
  }

  private hash(key: string): Map<string, string> | undefined {
    const entry = this.entry(key);
    if (entry === undefined) return undefined;
    if (entry.type !== 'hash') throw wrongType();
    return entry.value;
  }

  private zset(key: string): Map<string, number> | undefined {
    const entry = this.entry(key);
    if (entry === undefined) return undefined;
    if (entry.type !== 'zset') throw wrongType();
    return entry.value;
  }

  private createHash(key: string): Map<string, string> {
    const existing = this.hash(key);
    if (existing !== undefined) return existing;
    const value = new Map<string, string>();
    this.data.set(key, { type: 'hash', value, expiresAt: undefined });
    return value;
  }

  private createZset(key: string): Map<string, number> {
    const existing = this.zset(key);
    if (existing !== undefined) return existing;
    const value = new Map<string, number>();
    this.data.set(key, { type: 'zset', value, expiresAt: undefined });
    return value;
  }
}

/** Members by score, then ties by member, byte by byte, as Redis orders a sorted set. */
function sorted(zset: Map<string, number>): [string, number][] {
  return [...zset].sort(([ma, sa], [mb, sb]) => sa - sb || (ma < mb ? -1 : ma > mb ? 1 : 0));
}
