import type { Rule } from './types.js';

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
  /** Normalised exact path, or undefined. */
  readonly exactPath: string | undefined;
  /** Normalised wildcard prefix ("" for "/*"), or undefined. */
  readonly prefix: string | undefined;
  /** Upper-cased method, or undefined. */
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
 * them (decision 0011), so case, a trailing slash or HEAD can't dodge a rule.
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
  const { id, limit, windowMs, path, method, tier } = rule;
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

/** Express routes case-insensitively and ignores one trailing slash by default; so do we. */
function normalisePath(path: string): string {
  if (path === '') return '';
  const lower = path.toLowerCase();
  return lower.length > 1 && lower.endsWith('/') ? lower.slice(0, -1) : lower;
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
