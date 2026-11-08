import type { Rule } from './types.js';

/** Thrown at startup for an invalid rule. The message names the rule and what's wrong. */
export class InvalidRuleError extends Error {
  override name = 'InvalidRuleError';
}

/** The parts of a request the matcher reads. An Express `Request` satisfies this. */
export interface MatchableRequest {
  readonly method: string;
  readonly baseUrl: string;
  readonly path: string;
}

export type Matcher = (req: MatchableRequest, tier: string | undefined) => Rule | undefined;

interface CompiledRule {
  readonly rule: Rule;
  readonly index: number;
  readonly exactPath: string | undefined;
  readonly prefix: string | undefined;
  readonly method: string | undefined;
}

/**
 * Throws InvalidRuleError on the first problem. Checks types at runtime too,
 * because rules may come from YAML or JSON rather than typed code.
 */
export function validateRules(rules: unknown): asserts rules is readonly Rule[] {
  if (!Array.isArray(rules)) throw new InvalidRuleError('rules must be an array');
  const ids = new Set<string>();
  rules.forEach((rule: unknown, index) => {
    validateRule(rule, index, ids);
  });
}

/**
 * Validates the rules, then returns a function that picks the most specific
 * matching rule for a request. Paths and methods match the way Express routes
 * them (decisions 0011 and 0027), so case, a trailing slash, an encoding, `//`, `.`, `..` or
 * HEAD can't dodge a rule.
 */
export function createMatcher(rules: readonly Rule[]): Matcher {
  validateRules(rules);
  // A rule's specificity doesn't depend on the request, so rank once and take the first match.
  const ranked = rules.map(compileRule).sort(bySpecificity);

  return (req, tier) => {
    const path = normalisePath(req.baseUrl + req.path);
    const method = req.method.toUpperCase();
    return ranked.find((c) => matches(c, path, method, tier))?.rule;
  };
}

function validateRule(raw: unknown, index: number, ids: Set<string>): void {
  const position = `rules[${String(index)}]`;
  if (typeof raw !== 'object' || raw === null) {
    throw new InvalidRuleError(`${position}: must be an object`);
  }
  const rule = raw as Record<string, unknown>;
  const { id, limit, windowMs, burst, algorithm, path, method, tier } = rule;
  const label = typeof id === 'string' ? `${position} (${JSON.stringify(id)})` : position;
  const fail = (problem: string) => new InvalidRuleError(`${label}: ${problem}`);

  if (typeof id !== 'string' || id === '') throw fail('id must be a non-empty string');
  if (ids.has(id)) throw fail('id is already used by an earlier rule');
  ids.add(id);

  if (!isPositiveInteger(limit)) throw fail('limit must be a positive integer');
  if (!isPositiveInteger(windowMs)) throw fail('windowMs must be a positive integer');
  // The token bucket counts in integer units of limit * windowMs; past this, maths stops being exact.
  if (limit * windowMs > Number.MAX_SAFE_INTEGER) {
    throw fail('limit * windowMs must not exceed Number.MAX_SAFE_INTEGER');
  }
  if (burst !== undefined) {
    if (!isPositiveInteger(burst)) throw fail('burst must be a positive integer');
    // A token bucket with a burst holds integer units of burst * windowMs (decision 0022).
    if (burst * windowMs > Number.MAX_SAFE_INTEGER) {
      throw fail('burst * windowMs must not exceed Number.MAX_SAFE_INTEGER');
    }
  }

  if (algorithm !== undefined && (typeof algorithm !== 'string' || algorithm === '')) {
    throw fail('algorithm must be a non-empty string, a name from the algorithms option');
  }

  if (path !== undefined) {
    const problem = pathProblem(path);
    if (problem !== undefined) throw fail(problem);
  }
  if (method !== undefined && (typeof method !== 'string' || !/^[A-Za-z]+$/.test(method))) {
    throw fail('method must be an HTTP method name, such as "POST"');
  }
  if (tier !== undefined && (typeof tier !== 'string' || tier === '')) {
    throw fail('tier must be a non-empty string');
  }
}

function pathProblem(path: unknown): string | undefined {
  if (typeof path !== 'string' || !path.startsWith('/')) return 'path must start with "/"';
  if (path.includes('?') || path.includes('#')) {
    return 'path must not contain a query string or fragment';
  }
  const star = path.indexOf('*');
  if (star !== -1 && (star !== path.length - 1 || !path.endsWith('/*'))) {
    return 'path must be exact, like "/orders", or a prefix ending in "/*", like "/orders/*"';
  }
  return undefined;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function compileRule(rule: Rule, index: number): CompiledRule {
  const wildcard = rule.path?.endsWith('/*') ?? false;
  return {
    rule,
    index,
    exactPath: rule.path !== undefined && !wildcard ? normalisePath(rule.path) : undefined,
    // "/orders/*" → "/orders"; "/*" → "", which prefixes every path.
    prefix: rule.path !== undefined && wildcard ? normalisePath(rule.path.slice(0, -2)) : undefined,
    method: rule.method?.toUpperCase(),
  };
}

/**
 * The path a handler may end up serving, so that writing it another way can't dodge a rule
 * (decision 0027). Express routes case-insensitively and ignores a trailing slash. Handlers that
 * decode the path, such as `express.static` or a route with a `:param`, also treat `%64` as `d`,
 * `%2F` as `/`, `//` as `/` and resolve `.` and `..`. So this decodes once, drops empty and `.`
 * segments, resolves `..`, and lower-cases. Each step can only make more requests match a rule,
 * which errs towards limiting.
 */
function normalisePath(path: string): string {
  // "/*" compiles to the empty prefix, which matches every path.
  if (path === '') return '';
  const segments: string[] = [];
  for (const segment of decodePath(path).split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') segments.pop();
    else segments.push(segment);
  }
  return `/${segments.join('/')}`.toLowerCase();
}

/** Decodes percent-escapes once, as a handler would. A malformed escape is left as it is. */
function decodePath(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

function pathRank(c: CompiledRule): number {
  if (c.exactPath !== undefined) return 2;
  return c.prefix !== undefined ? 1 : 0;
}

/** Most specific first: path kind, longer wildcard prefix, tier set, method set, then declaration order. */
function bySpecificity(a: CompiledRule, b: CompiledRule): number {
  return (
    pathRank(b) - pathRank(a) ||
    (b.prefix?.length ?? 0) - (a.prefix?.length ?? 0) ||
    Number(b.rule.tier !== undefined) - Number(a.rule.tier !== undefined) ||
    Number(b.method !== undefined) - Number(a.method !== undefined) ||
    a.index - b.index
  );
}

function matches(c: CompiledRule, path: string, method: string, tier: string | undefined): boolean {
  if (c.exactPath !== undefined && path !== c.exactPath) return false;
  if (c.prefix !== undefined && path !== c.prefix && !path.startsWith(c.prefix + '/')) {
    return false;
  }
  // Express runs GET handlers for HEAD requests, so a GET limit has to cover HEAD too.
  if (c.method !== undefined && method !== c.method && !(method === 'HEAD' && c.method === 'GET')) {
    return false;
  }
  return c.rule.tier === undefined || c.rule.tier === tier;
}
