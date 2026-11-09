// Three app instances behind a round-robin load balancer, sharing one (stand-in) Redis, each with
// its own in-memory fallback, as in the real stack (docker-compose.yml). Each request goes
// through what the middleware does with a check: the algorithm, bounded by the timeout, then the
// instance's fallback if it fails, then the headers. Those pieces are the library's own.
import { createFallback, fallbackRule, type Fallback } from '../../../src/fallback.ts';
import { rateLimitHeaders, retryAfter } from '../../../src/headers.ts';
import { withTimeout } from '../../../src/timeout.ts';
import type { Algorithm, Clock, Decision, Rule } from '../../../src/types.ts';
import type { AlgorithmName } from '../redis/scripts.ts';

/** What a client gets back for one request, with what the demo shows about how it was decided. */
export interface SimResponse {
  /** 1, 2, 3…: the order requests were sent in. */
  readonly seq: number;
  /** Simulated time the request arrived, in ms. */
  readonly at: number;
  /** Which instance answered, from 1. */
  readonly instance: number;
  readonly algorithm: AlgorithmName;
  readonly status: 200 | 429;
  /** `shared`: decided by the shared Redis. `fallback`: Redis was down, so the instance decided alone. */
  readonly source: 'shared' | 'fallback';
  /** The storage key the check used. */
  readonly key: string;
  /** The limit the decision was made against: the instance's share of it during an outage. */
  readonly limit: number;
  readonly decision: Decision;
  readonly headers: Readonly<Record<string, string>>;
}

export interface ClusterOptions {
  readonly algorithms: Readonly<Record<AlgorithmName, Algorithm>>;
  /** The stand-in Redis: taking it down makes every check fail, so the fallbacks answer. */
  readonly redis: { readonly down: boolean; setDown(down: boolean): void };
  readonly clock: Clock;
  /** Default 3. */
  readonly instances?: number;
  /** The middleware's default, 50 ms. */
  readonly timeoutMs?: number;
}

export interface Cluster {
  readonly instances: number;
  /**
   * Sends one request, to the next instance in turn, which checks it with each of `algorithms`
   * against its own copy of `rule` (the rule ID gets the algorithm's name, so their keys never
   * collide). One response per algorithm, all from the same instance at the same moment.
   */
  send(rule: Rule, algorithms: readonly AlgorithmName[], clientId?: string): Promise<SimResponse[]>;
  /** Takes Redis down, or brings it back with its data kept (a restart with persistence). */
  setRedisDown(down: boolean): void;
  readonly redisDown: boolean;
  /** Back to the first instance, with empty fallbacks. The caller clears Redis. */
  reset(): void;
  close(): void;
}

/** The rule as one algorithm checks it: its own ID, so its key is its own. */
export function ruleFor(rule: Rule, algorithm: AlgorithmName): Rule {
  return { ...rule, id: `${rule.id}-${algorithm}` };
}

export function createCluster(opts: ClusterOptions): Cluster {
  const instances = opts.instances ?? 3;
  const timeoutMs = opts.timeoutMs ?? 50;
  const newFallbacks = () =>
    Array.from({ length: instances }, () => createFallback(instances, opts.clock));
  let fallbacks: Fallback[] = newFallbacks();
  let next = 0;
  let seq = 0;

  const closeFallbacks = () => {
    for (const fallback of fallbacks) fallback.close();
  };

  async function check(
    index: number,
    request: number,
    at: number,
    base: Rule,
    name: AlgorithmName,
    clientId: string,
  ): Promise<SimResponse> {
    const algorithm = opts.algorithms[name];
    const rule = ruleFor(base, name);
    // The key format is the library's (decision 0028), with its default prefix. buildKey lives
    // in identify.ts, which needs node:net, so it's spelled out here.
    const key = `rl:${rule.id}:${clientId}`;
    const result = await withTimeout(() => algorithm.check(key, rule), timeoutMs);
    let applied = rule;
    let decision: Decision;
    let source: SimResponse['source'] = 'shared';
    if (result.ok) {
      decision = result.value;
    } else {
      const fallback = fallbacks[index];
      // index is always below instances, so fallbacks[index] exists; checked for the types.
      if (fallback === undefined) throw new Error(`no fallback for instance ${String(index)}`);
      ({ rule: applied, decision } = await fallback.check(key, fallbackRule(rule, algorithm)));
      source = 'fallback';
    }
    const headers: Record<string, string> = { ...rateLimitHeaders(applied, decision) };
    if (!decision.allowed) headers['Retry-After'] = retryAfter(decision);
    return {
      seq: request,
      at,
      instance: index + 1,
      algorithm: name,
      status: decision.allowed ? 200 : 429,
      source,
      key,
      limit: applied.limit,
      decision,
      headers,
    };
  }

  return {
    instances,
    async send(rule, algorithms, clientId = 'visitor') {
      // Taken before anything is awaited, so requests sent together still go round in order.
      const index = next;
      next = (next + 1) % instances;
      seq += 1;
      const request = seq;
      const at = opts.clock.now();
      const responses: SimResponse[] = [];
      // One after another, as one instance handling the request would.
      for (const name of algorithms) {
        responses.push(await check(index, request, at, rule, name, clientId));
      }
      return responses;
    },
    setRedisDown(down) {
      opts.redis.setDown(down);
    },
    get redisDown() {
      return opts.redis.down;
    },
    reset() {
      closeFallbacks();
      fallbacks = newFallbacks();
      next = 0;
      seq = 0;
    },
    close() {
      closeFallbacks();
    },
  };
}
