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

export function fromIoredis(client: IoredisLike): RedisScriptClient {
  // node-redis spells it evalSha, so this also catches the wrong client being passed, at startup.
  assertMethods(client, ['evalsha', 'eval'], 'fromIoredis', 'fromNodeRedis');
  return {
    evalsha: (sha, keys, args) => client.evalsha(sha, keys.length, ...keys, ...args),
    eval: (script, keys, args) => client.eval(script, keys.length, ...keys, ...args),
  };
}

export function fromNodeRedis(client: NodeRedisLike): RedisScriptClient {
  assertMethods(client, ['evalSha', 'eval'], 'fromNodeRedis', 'fromIoredis');
  return {
    evalsha: (sha, keys, args) => client.evalSha(sha, { keys, arguments: args }),
    eval: (script, keys, args) => client.eval(script, { keys, arguments: args }),
  };
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
