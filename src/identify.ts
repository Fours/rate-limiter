import { createHash } from 'node:crypto';
import type { Rule } from './types.js';

/** The parts of a request identification reads. An Express `Request` satisfies this. */
export interface IdentifiableRequest {
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly ip?: string | undefined;
  /** Set by auth middleware, if any. Express doesn't type it, so its shape is checked at runtime. */
  readonly user?: unknown;
}

/**
 * Picks the client ID from the first source present: API key, then user ID,
 * then IP, then "anon". An empty value counts as absent, so a blank header
 * can't put every such client into one shared bucket.
 */
export function defaultIdentify(req: IdentifiableRequest): string {
  // Node joins a repeated header into one "a, b" string, so a string is all we expect here.
  const apiKey = req.headers['x-api-key'];
  if (typeof apiKey === 'string' && apiKey !== '') return `key_${hashApiKey(apiKey)}`;

  const userId = readUserId(req.user);
  if (userId !== undefined) return `user_${userId}`;

  if (typeof req.ip === 'string' && req.ip !== '') return `ip_${req.ip}`;
  return 'anon';
}

/** `rl:{rule.id}:{clientId}`, for example `rl:orders:free:key_3f2a9c1e5b7d4e8a`. */
export function buildKey(rule: Pick<Rule, 'id'>, clientId: string): string {
  return `rl:${rule.id}:${clientId}`;
}

/**
 * The raw key must never reach storage keys, logs or metric labels (decision 0002).
 * Changing the hash or its length would orphan every stored bucket, so a test pins it.
 */
function hashApiKey(apiKey: string): string {
  return createHash('sha256').update(apiKey).digest('hex').slice(0, 16);
}

function readUserId(user: unknown): string | undefined {
  if (typeof user !== 'object' || user === null || !('id' in user)) return undefined;
  const { id } = user;
  if (typeof id === 'string' && id !== '') return id;
  if (typeof id === 'number' && Number.isFinite(id)) return String(id);
  return undefined;
}
