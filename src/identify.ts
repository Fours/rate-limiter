import { createHash } from 'node:crypto';
import { isIPv4, isIPv6 } from 'node:net';
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
 *
 * IPs are grouped as decision 0020 describes: an IPv6 client by its /64, and an IPv4-mapped
 * address as the IPv4 address it carries.
 */
export function defaultIdentify(req: IdentifiableRequest): string {
  // Node joins a repeated header into one "a, b" string, so a string is all we expect here.
  const apiKey = req.headers['x-api-key'];
  if (typeof apiKey === 'string' && apiKey !== '') return `key_${hashApiKey(apiKey)}`;

  const userId = readUserId(req.user);
  if (userId !== undefined) return `user_${userId}`;

  if (typeof req.ip === 'string' && req.ip !== '') return `ip_${normalizeIp(req.ip) ?? req.ip}`;
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

/**
 * The form of an IP that identifies a client (decision 0020), or undefined if it isn't an IP.
 *
 * - IPv4 stays as it is.
 * - IPv4-mapped IPv6 (`::ffff:1.2.3.4`, or `::ffff:102:304`) is the IPv4 address it carries.
 *   On a server listening on `::`, Node's default, every IPv4 client arrives in this form.
 * - Any other IPv6 is its /64, in RFC 5952 form: `2001:db8:1:2::/64`. One host usually gets a
 *   whole /64, and could otherwise pick a new address, and a new limit, for every request.
 *
 * Brackets and a zone (`%eth0`) are dropped first: behind `trust proxy`, Express passes
 * X-Forwarded-For through as it was sent, so both reach `req.ip` (0020's probe).
 */
export function normalizeIp(ip: string): string | undefined {
  let address = ip.startsWith('[') && ip.endsWith(']') ? ip.slice(1, -1) : ip;
  const zone = address.indexOf('%');
  if (zone !== -1) address = address.slice(0, zone);

  if (isIPv4(address)) return address;
  if (!isIPv6(address)) return undefined;

  const groups = ipv6Groups(address);
  const [g0, g1, g2, g3, g4, g5, g6 = 0, g7 = 0] = groups;
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
    return [g6 >> 8, g6 & 0xff, g7 >> 8, g7 & 0xff].join('.');
  }
  return `${formatIpv6([...groups.slice(0, 4), 0, 0, 0, 0])}/64`;
}

/** The eight 16-bit groups of a valid IPv6 address, with `::` and a dotted IPv4 tail expanded. */
function ipv6Groups(address: string): number[] {
  let text = address;
  const lastColon = text.lastIndexOf(':');
  const tail = text.slice(lastColon + 1);
  if (tail.includes('.')) {
    const [a = 0, b = 0, c = 0, d = 0] = tail.split('.').map(Number);
    text = `${text.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const parse = (part: string) => (part === '' ? [] : part.split(':').map((g) => parseInt(g, 16)));
  const gap = text.indexOf('::');
  if (gap === -1) return parse(text);
  const head = parse(text.slice(0, gap));
  const rest = parse(text.slice(gap + 2));
  return [...head, ...new Array<number>(8 - head.length - rest.length).fill(0), ...rest];
}

/** RFC 5952: lowercase hex, no leading zeros, and the longest run of two or more zero groups as `::`. */
function formatIpv6(groups: readonly number[]): string {
  let bestStart = -1;
  let bestLength = 1;
  for (let i = 0; i < groups.length;) {
    if (groups[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < groups.length && groups[j] === 0) j++;
    if (j - i > bestLength) {
      bestStart = i;
      bestLength = j - i;
    }
    i = j;
  }
  const hex = groups.map((g) => g.toString(16));
  if (bestStart === -1) return hex.join(':');
  const head = hex.slice(0, bestStart).join(':');
  const tail = hex.slice(bestStart + bestLength).join(':');
  return `${head}::${tail}`;
}
