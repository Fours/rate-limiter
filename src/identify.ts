import { isIPv4, isIPv6 } from 'node:net';
import type { Rule } from './types.js';

/** The parts of a request identification reads. An Express `Request` satisfies this. */
export interface IdentifiableRequest {
  readonly ip?: string | undefined;
  /** The connection. Its address is used when `ip` isn't an IP (decision 0029). */
  readonly socket?: { readonly remoteAddress?: string | undefined } | undefined;
  /** Set by auth middleware, if any. Express doesn't type it, so its shape is checked at runtime. */
  readonly user?: unknown;
}

/**
 * Picks the client ID from the first source present: `req.user.id`, then the IP, then "anon".
 * An empty value counts as absent, so it can't put every such client into one shared bucket.
 *
 * Only what the app has verified identifies a client. An API key header is never read: the
 * limiter can't tell a real key from a made-up one, and a client that sent a new key on every
 * request would get a new limit each time (decision 0026). To limit by key, check it in your
 * auth middleware, set `req.user`, and mount the limiter after it.
 *
 * IPs are grouped as decisions 0020 and 0029 describe: an IPv6 client by its /64, and an IPv6
 * address that carries an IPv4 one as that IPv4 address. A `req.ip` that isn't an IP, which only
 * a forged `X-Forwarded-For` can produce, gives way to the connection's own address.
 */
export function defaultIdentify(req: IdentifiableRequest): string {
  const userId = readUserId(req.user);
  if (userId !== undefined) return `user_${userId}`;

  if (typeof req.ip === 'string' && req.ip !== '') {
    // Not the raw value: any string a client sent would be a new client, and a long one a long key.
    const ip = normalizeIp(req.ip) ?? normalizeIp(req.socket?.remoteAddress ?? '');
    if (ip !== undefined) return `ip_${ip}`;
  }
  return 'anon';
}

/**
 * The storage key for a rule and client: `{prefix}:{rule.id}:{clientId}`, for example
 * `rl:orders:free:user_42`. `prefix` is `rateLimit`'s `prefix` option, `rl` by default. The
 * middleware builds keys this way; it's exported for tooling that inspects or clears keys in
 * Redis.
 */
export function buildKey(rule: Pick<Rule, 'id'>, clientId: string, prefix = 'rl'): string {
  return `${prefix}:${rule.id}:${clientId}`;
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
 * - IPv6 that carries an IPv4 address is that IPv4 address (decision 0029): IPv4-mapped
 *   (`::ffff:1.2.3.4`, or `::ffff:102:304`), which is how every IPv4 client reaches a server
 *   listening on `::`, Node's default; translated (`::ffff:0:1.2.3.4`); the well-known NAT64
 *   prefix (`64:ff9b::1.2.3.4`); and the old IPv4-compatible form (`::1.2.3.4`). Otherwise every
 *   IPv4 client behind one translator would share one /64.
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
  const [, , , , , , g6 = 0, g7 = 0] = groups;
  if (carriesIpv4(groups)) return [g6 >> 8, g6 & 0xff, g7 >> 8, g7 & 0xff].join('.');
  return `${formatIpv6([...groups.slice(0, 4), 0, 0, 0, 0])}/64`;
}

/** Whether the first 96 bits are one of the prefixes that put an IPv4 address in the last 32. */
function carriesIpv4(groups: readonly number[]): boolean {
  const [g0, g1, g2, g3, g4, g5, g6] = groups;
  const zeroTo = (n: number) => groups.slice(0, n).every((g) => g === 0);
  return (
    (zeroTo(5) && g5 === 0xffff) || // ::ffff:0:0/96, mapped
    (zeroTo(4) && g4 === 0xffff && g5 === 0) || // ::ffff:0:0:0/96, translated (RFC 2765)
    (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) || // NAT64
    // ::/96, IPv4-compatible (deprecated). Not :: or ::1, whose third-last group is 0.
    (zeroTo(6) && g6 !== 0)
  );
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
