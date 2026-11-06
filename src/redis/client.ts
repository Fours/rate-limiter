/**
 * The only Redis operations the library needs. The caller brings their own client, already
 * configured with their connection, TLS and auth settings (decision 0013).
 */
export interface RedisScriptClient {
  evalsha(sha: string, keys: string[], args: string[]): Promise<unknown>;
  eval(script: string, keys: string[], args: string[]): Promise<unknown>;
}

/** The part of an `ioredis` client the adapter uses. A `Redis` instance satisfies it. */
export interface IoredisLike {
  evalsha(sha: string, numKeys: number, ...keysAndArgs: string[]): Promise<unknown>;
  eval(script: string, numKeys: number, ...keysAndArgs: string[]): Promise<unknown>;
}

/** The part of a `node-redis` client the adapter uses. A connected `createClient()` satisfies it. */
export interface NodeRedisLike {
  evalSha(sha: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
}

/** Marks clients made by the adapters, so a raw ioredis client can be told apart at startup. */
const ADAPTED = Symbol('rate-limiter.adapted');

export function fromIoredis(client: IoredisLike): RedisScriptClient {
  // node-redis spells it evalSha, so this also catches the wrong client being passed, at startup.
  assertMethods(client, ['evalsha', 'eval'], 'fromIoredis', 'fromNodeRedis');
  return mark({
    evalsha: (sha, keys, args) => client.evalsha(sha, keys.length, ...keys, ...args),
    eval: (script, keys, args) => client.eval(script, keys.length, ...keys, ...args),
  });
}

export function fromNodeRedis(client: NodeRedisLike): RedisScriptClient {
  assertMethods(client, ['evalSha', 'eval'], 'fromNodeRedis', 'fromIoredis');
  return mark({
    evalsha: (sha, keys, args) => client.evalSha(sha, { keys, arguments: args }),
    eval: (script, keys, args) => client.eval(script, { keys, arguments: args }),
  });
}

function mark(client: RedisScriptClient): RedisScriptClient {
  return Object.defineProperty(client, ADAPTED, { value: true });
}

/**
 * Checks, at startup, that `value` can run scripts the way the algorithms call them. A raw
 * ioredis client has evalsha and eval too, but takes different arguments, so without this it
 * would pass the shape check and then fail on every request. Hand-written clients that don't
 * look like ioredis are accepted, as decision 0013 promises.
 */
export function assertScriptClient(
  value: unknown,
  where: string,
): asserts value is RedisScriptClient {
  if (typeof value !== 'object' || value === null) {
    throw new TypeError(`${where}: client must be a RedisScriptClient, such as fromIoredis(redis)`);
  }
  const client = value as Record<PropertyKey, unknown>;
  if (typeof client.evalSha === 'function') {
    throw new TypeError(
      `${where}: this looks like a node-redis client. Wrap it: fromNodeRedis(client)`,
    );
  }
  if (client[ADAPTED] !== true && typeof client.defineCommand === 'function') {
    throw new TypeError(
      `${where}: this looks like an ioredis client. Wrap it: fromIoredis(client)`,
    );
  }
  if (typeof client.evalsha !== 'function' || typeof client.eval !== 'function') {
    throw new TypeError(
      `${where}: client must have evalsha and eval methods, such as fromIoredis(redis)`,
    );
  }
}

/** Checked at runtime because plain JS callers bypass the types. */
function assertMethods(client: unknown, methods: string[], adapter: string, other: string): void {
  const ok =
    typeof client === 'object' &&
    client !== null &&
    methods.every((m) => typeof (client as Record<string, unknown>)[m] === 'function');
  if (!ok) {
    throw new TypeError(
      `${adapter}: expected a client with ${methods.join(' and ')} methods. ` +
        `For the other Redis library, use ${other}.`,
    );
  }
}
