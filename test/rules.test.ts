import { describe, expect, it } from 'vitest';
import {
  createMatcher,
  InvalidRuleError,
  validateRules,
  type MatchableRequest,
} from '../src/rules.js';
import type { Rule } from '../src/types.js';

const base = { limit: 10, windowMs: 1_000 };

function req(method: string, path: string, baseUrl = ''): MatchableRequest {
  return { method, path, baseUrl };
}

/** Id of the rule the matcher picks, or undefined. */
function pick(rules: Rule[], request: MatchableRequest, tier?: string): string | undefined {
  return createMatcher(rules)(request, tier)?.id;
}

describe('validateRules', () => {
  it('throws an InvalidRuleError by that name, for logs and instanceof alike', () => {
    expect(() => {
      validateRules('x');
    }).toThrow(expect.objectContaining({ name: 'InvalidRuleError' }) as Error);
  });

  it('accepts valid rules, including an empty list', () => {
    expect(() => {
      validateRules([
        { id: 'global', ...base },
        { id: 'orders:free', ...base, method: 'post', path: '/orders/*', tier: 'free' },
        { id: 'root', ...base, path: '/' },
        { id: 'all', ...base, path: '/*' },
      ]);
    }).not.toThrow();
    expect(() => {
      validateRules([]);
    }).not.toThrow();
  });

  it('rejects a non-array', () => {
    expect(() => {
      validateRules({ id: 'a', ...base });
    }).toThrow(new InvalidRuleError('rules must be an array'));
  });

  it('rejects a rule that is not an object', () => {
    expect(() => {
      validateRules([null]);
    }).toThrow(new InvalidRuleError('rules[0]: must be an object'));
  });

  it.each([
    ['missing', { ...base }],
    ['empty', { id: '', ...base }],
    ['not a string', { id: 7, ...base }],
  ])('rejects an id that is %s', (_case, rule) => {
    expect(() => {
      validateRules([rule]);
    }).toThrow(/^rules\[0\].*: id must be a non-empty string$/);
  });

  it('rejects a duplicate id and names the second rule', () => {
    expect(() => {
      validateRules([
        { id: 'a', ...base },
        { id: 'a', ...base },
      ]);
    }).toThrow(new InvalidRuleError('rules[1] ("a"): id is already used by an earlier rule'));
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '10', undefined])(
    'rejects limit %s',
    (limit) => {
      expect(() => {
        validateRules([{ ...base, id: 'a', limit }]);
      }).toThrow(new InvalidRuleError('rules[0] ("a"): limit must be a positive integer'));
    },
  );

  it.each([0, -1, 1.5, Number.NaN, '1000', undefined])('rejects windowMs %s', (windowMs) => {
    expect(() => {
      validateRules([{ ...base, id: 'a', windowMs }]);
    }).toThrow(new InvalidRuleError('rules[0] ("a"): windowMs must be a positive integer'));
  });

  it('accepts a burst below, equal to or above the limit', () => {
    expect(() => {
      validateRules([
        { id: 'a', ...base, burst: 1 },
        { id: 'b', ...base, burst: 10 },
        { id: 'c', ...base, burst: 50 },
      ]);
    }).not.toThrow();
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '5', null])(
    'rejects burst %s',
    (burst) => {
      expect(() => {
        validateRules([{ ...base, id: 'a', burst }]);
      }).toThrow(new InvalidRuleError('rules[0] ("a"): burst must be a positive integer'));
    },
  );

  it.each(['limit', 'burst'] as const)(
    'rejects %s * windowMs above 2^51, and accepts it at the edge',
    (field) => {
      // Found by the 1.0 correctness review: up to 2^53 passed here, but the scripts' replies,
      // up to twice windowMs, then went past the safe integers and failed every check.
      const at = (n: number, windowMs: number): Rule =>
        field === 'limit'
          ? { id: 'r', limit: n, windowMs }
          : { id: 'r', limit: 1, burst: n, windowMs };
      expect(() => {
        validateRules([at(2 ** 11, 2 ** 40)]);
      }).not.toThrow();
      expect(() => {
        validateRules([at(1, 2 ** 51)]);
      }).not.toThrow();
      expect(() => {
        validateRules([at(2 ** 11 + 1, 2 ** 40)]);
      }).toThrow(
        new InvalidRuleError(
          `rules[0] ("r"): ${field} * windowMs must be at most 2^51 (2251799813685248)`,
        ),
      );
      expect(() => {
        validateRules([at(1, Number.MAX_SAFE_INTEGER)]);
      }).toThrow(/must be at most 2\^51/);
    },
  );

  it.each([
    ['orders', 'path must start with "/"'],
    [42, 'path must start with "/"'],
    ['/orders?page=1', 'path must not contain a query string or fragment'],
    ['/orders#top', 'path must not contain a query string or fragment'],
    [
      '/orders*',
      'path must be exact, like "/orders", or a prefix ending in "/*", like "/orders/*"',
    ],
    [
      '/*/items',
      'path must be exact, like "/orders", or a prefix ending in "/*", like "/orders/*"',
    ],
    ['/a/*/*', 'path must be exact, like "/orders", or a prefix ending in "/*", like "/orders/*"'],
  ])('rejects path %j', (path, problem) => {
    expect(() => {
      validateRules([{ id: 'a', ...base, path }]);
    }).toThrow(new InvalidRuleError(`rules[0] ("a"): ${problem}`));
  });

  it.each(['methd', 'limt', 'windowMS', 'paths'])(
    'rejects an unknown field %j in rules written in code, as in files (0032)',
    (field) => {
      // Found by the 1.0 correctness review: `methd: 'POST'` made a POST-only rule cover every method.
      expect(() => {
        validateRules([{ id: 'a', ...base, [field]: 'POST' }]);
      }).toThrow(
        new InvalidRuleError(
          `rules[0] ("a"): unknown field ${JSON.stringify(field)}; allowed fields are id, limit, windowMs, burst, algorithm, method, path, tier`,
        ),
      );
    },
  );

  it.each(['', 'GET ', 'PO-ST', 3])('rejects method %j', (method) => {
    expect(() => {
      validateRules([{ id: 'a', ...base, method }]);
    }).toThrow(
      new InvalidRuleError('rules[0] ("a"): method must be an HTTP method name, such as "POST"'),
    );
  });

  it.each(['', 3, null])('rejects algorithm %j', (algorithm) => {
    expect(() => {
      validateRules([{ ...base, id: 'a', algorithm }]);
    }).toThrow(
      new InvalidRuleError(
        'rules[0] ("a"): algorithm must be a non-empty string, a name from the algorithms option',
      ),
    );
  });

  it.each(['', 1])('rejects tier %j', (tier) => {
    expect(() => {
      validateRules([{ id: 'a', ...base, tier }]);
    }).toThrow(new InvalidRuleError('rules[0] ("a"): tier must be a non-empty string'));
  });

  it('is what createMatcher runs, so invalid rules throw at creation', () => {
    expect(() => createMatcher([{ id: 'a', limit: 0, windowMs: 1_000 }])).toThrow(InvalidRuleError);
  });
});

describe('createMatcher', () => {
  describe('paths', () => {
    const rules: Rule[] = [{ id: 'exact', ...base, path: '/orders' }];

    it('matches an exact path only', () => {
      expect(pick(rules, req('GET', '/orders'))).toBe('exact');
      expect(pick(rules, req('GET', '/orders/1'))).toBeUndefined();
      expect(pick(rules, req('GET', '/ordersXYZ'))).toBeUndefined();
    });

    it('matches a wildcard prefix, the prefix itself, and nothing that merely starts the same', () => {
      const wild: Rule[] = [{ id: 'wild', ...base, path: '/orders/*' }];
      expect(pick(wild, req('GET', '/orders'))).toBe('wild');
      expect(pick(wild, req('GET', '/orders/1'))).toBe('wild');
      expect(pick(wild, req('GET', '/orders/1/items'))).toBe('wild');
      expect(pick(wild, req('GET', '/ordersXYZ'))).toBeUndefined();
      expect(pick(wild, req('GET', '/'))).toBeUndefined();
    });

    it('matches every path with "/*" and with no path', () => {
      for (const rule of [
        { id: 'all', ...base, path: '/*' },
        { id: 'all', ...base },
      ]) {
        expect(pick([rule], req('GET', '/'))).toBe('all');
        expect(pick([rule], req('GET', '/anything/at/all'))).toBe('all');
      }
    });

    it('matches regardless of case and one trailing slash, like Express', () => {
      expect(pick(rules, req('GET', '/ORDERS'))).toBe('exact');
      expect(pick(rules, req('GET', '/orders/'))).toBe('exact');
      expect(pick(rules, req('GET', '/Orders/'))).toBe('exact');
      expect(pick([{ id: 'mixed', ...base, path: '/Orders/' }], req('GET', '/orders'))).toBe(
        'mixed',
      );
    });

    it.each([
      ['a percent-escape', '/%6frders'],
      ['an encoded slash', '/api%2forders'],
      ['a doubled slash', '//api//orders'],
      ['several trailing slashes', '/api/orders//'],
      ['a dot segment', '/./api/./orders'],
      ['a dot-dot segment', '/x/../api/orders'],
      ['an encoded dot-dot segment', '/x/%2e%2e/api/orders'],
      ['dot-dot above the root', '/../../api/orders'],
    ])('matches %s the way a decoding handler reads it (0027)', (_label, path) => {
      const api: Rule[] = [
        { id: 'exact', ...base, path: path.includes('api') ? '/api/orders' : '/orders' },
      ];
      expect(pick(api, req('GET', path))).toBe('exact');
    });

    it('decodes once only, as a handler does, and keeps a malformed escape as it is', () => {
      const rules: Rule[] = [
        { id: 'dot', ...base, path: '/a.b' },
        { id: 'bad', ...base, path: '/a%zz' },
      ];
      expect(pick(rules, req('GET', '/a%2eb'))).toBe('dot');
      // A handler decodes "%252e" once, to "%2e": another file than "a.b".
      expect(pick(rules, req('GET', '/a%252eb'))).toBeUndefined();
      expect(pick(rules, req('GET', '/A%zz'))).toBe('bad');
    });

    it('still decodes the other segments when one has a malformed escape', () => {
      const wild: Rule[] = [{ id: 'acme', ...base, path: '/t/acme/*' }];
      expect(pick(wild, req('GET', '/t/%61cme/report%zz'))).toBe('acme');
      expect(pick(wild, req('GET', '/t/%zz/../%61cme/x'))).toBe('acme');
    });

    it.each(['/*', '/./*', '//*', '/x/../*', '/%2E/*'])(
      'matches every path with %s, like /*',
      (path) => {
        // Found by the 1.0 correctness review: all but /* compiled to the prefix "/", which
        // matched only the root.
        const all: Rule[] = [{ id: 'all', ...base, path }];
        for (const request of ['/', '/orders', '/a/b/c']) {
          expect(pick(all, req('GET', request))).toBe('all');
        }
      },
    );

    it('applies the same normalisation to wildcard prefixes', () => {
      const wild: Rule[] = [{ id: 'wild', ...base, path: '/downloads/*' }];
      expect(pick(wild, req('GET', '/%64ownloads/big.zip'))).toBe('wild');
      expect(pick(wild, req('GET', '/downloads%2fbig.zip'))).toBe('wild');
      expect(pick(wild, req('GET', '/downloads/../other'))).toBe('wild');
    });

    it.each([
      ['a dot-dot route parameter', '/admin/..'],
      ['an encoded dot-dot', '/admin/%2e%2e'],
      ['an encoded slash before dot-dot', '/admin/..%2fx'],
      ['dot-dot that climbs out', '/admin/x/../../y'],
    ])('matches %s by the routing reading, which keeps ".." (0030)', (_label, path) => {
      const admin: Rule[] = [{ id: 'admin', ...base, path: '/admin/*' }];
      expect(pick(admin, req('GET', path))).toBe('admin');
    });

    it('picks the most specific rule that either reading matches (0030)', () => {
      const rules: Rule[] = [
        { id: 'x', ...base, path: '/x/*' },
        { id: 'downloads', ...base, path: '/downloads/*' },
      ];
      // Routed, it's under /x; resolved, under /downloads. The longer prefix wins, as usual.
      expect(pick(rules, req('GET', '/x/../downloads/f'))).toBe('downloads');
      expect(pick(rules, req('GET', '/x/../y'))).toBe('x');
    });

    it('joins baseUrl and path, so rules work inside mounted routers', () => {
      const api: Rule[] = [
        { id: 'api-orders', ...base, path: '/api/orders' },
        { id: 'api-root', ...base, path: '/api' },
      ];
      expect(pick(api, req('GET', '/orders', '/api'))).toBe('api-orders');
      expect(pick(api, req('GET', '/orders', '/API'))).toBe('api-orders');
      // A router's own root arrives as baseUrl "/api" + path "/".
      expect(pick(api, req('GET', '/', '/api'))).toBe('api-root');
      expect(pick(api, req('GET', '/orders'))).toBeUndefined();
    });
  });

  describe('methods', () => {
    const rules: Rule[] = [{ id: 'get', ...base, method: 'get' }];

    it('compares methods case-insensitively', () => {
      expect(pick(rules, req('GET', '/'))).toBe('get');
      expect(pick([{ id: 'post', ...base, method: 'POST' }], req('post', '/'))).toBe('post');
    });

    it('lets a GET rule cover HEAD, because Express runs GET handlers for HEAD', () => {
      expect(pick(rules, req('HEAD', '/'))).toBe('get');
    });

    it('does not match other methods', () => {
      expect(pick(rules, req('POST', '/'))).toBeUndefined();
      expect(pick([{ id: 'head', ...base, method: 'HEAD' }], req('GET', '/'))).toBeUndefined();
      // Only a GET rule: HEAD doesn't run POST handlers.
      expect(pick([{ id: 'post', ...base, method: 'POST' }], req('HEAD', '/'))).toBeUndefined();
    });
  });

  describe('tiers', () => {
    const rules: Rule[] = [{ id: 'free', ...base, tier: 'free' }];

    it('matches only the same tier, compared exactly', () => {
      expect(pick(rules, req('GET', '/'), 'free')).toBe('free');
      expect(pick(rules, req('GET', '/'), 'pro')).toBeUndefined();
      expect(pick(rules, req('GET', '/'), 'FREE')).toBeUndefined();
      expect(pick(rules, req('GET', '/'))).toBeUndefined();
    });
  });

  describe('specificity', () => {
    const r = req('POST', '/orders/1');

    it('prefers an exact path over a wildcard', () => {
      const rules: Rule[] = [
        { id: 'wild', ...base, path: '/orders/*' },
        { id: 'exact', ...base, path: '/orders/1' },
      ];
      expect(pick(rules, r)).toBe('exact');
    });

    it('prefers a wildcard over no path', () => {
      const rules: Rule[] = [
        { id: 'none', ...base },
        { id: 'wild', ...base, path: '/orders/*' },
      ];
      expect(pick(rules, r)).toBe('wild');
    });

    it('prefers the longer of two wildcard prefixes', () => {
      const rules: Rule[] = [
        { id: 'short', ...base, path: '/*' },
        { id: 'long', ...base, path: '/orders/*' },
      ];
      expect(pick(rules, r)).toBe('long');
    });

    it('prefers a rule with a tier over one without', () => {
      const rules: Rule[] = [
        { id: 'any', ...base, path: '/orders/*' },
        { id: 'free', ...base, path: '/orders/*', tier: 'free' },
      ];
      expect(pick(rules, r, 'free')).toBe('free');
      expect(pick(rules, r, 'pro')).toBe('any');
    });

    it('prefers a rule with a method over one without', () => {
      const rules: Rule[] = [
        { id: 'any', ...base, path: '/orders/*' },
        { id: 'post', ...base, path: '/orders/*', method: 'POST' },
      ];
      expect(pick(rules, r)).toBe('post');
      expect(pick(rules, req('GET', '/orders/1'))).toBe('any');
    });

    it('ranks path before tier, and tier before method', () => {
      const rules: Rule[] = [
        { id: 'tier-and-method', ...base, tier: 'free', method: 'POST' },
        { id: 'method', ...base, path: '/orders/*', method: 'POST' },
        { id: 'tier', ...base, path: '/orders/*', tier: 'free' },
        { id: 'path', ...base, path: '/orders/*' },
      ];
      expect(pick(rules, r, 'free')).toBe('tier');
      expect(pick(rules.slice(0, 2), r, 'free')).toBe('method');
    });

    it('falls back to declaration order on a full tie', () => {
      const first: Rule = { id: 'first', ...base, path: '/orders/*', method: 'POST' };
      const second: Rule = { id: 'second', ...base, path: '/orders/*', method: 'post' };
      expect(pick([first, second], r)).toBe('first');
      expect(pick([second, first], r)).toBe('second');
    });

    it('keeps declaration order among many tied rules, after more specific ones', () => {
      // Found by mutation testing: with two rules, a comparator that ignored order still
      // happened to sort them right.
      const tied = ['a', 'b', 'c', 'd', 'e'].map((id): Rule => ({
        id,
        ...base,
        path: '/orders/*',
      }));
      const exact: Rule = { id: 'exact', ...base, path: '/orders/7' };
      expect(pick([...tied, exact], req('POST', '/orders/7'))).toBe('exact');
      expect(pick([...tied, exact], req('POST', '/orders/8'))).toBe('a');
      expect(pick([...tied].reverse(), req('POST', '/orders/8'))).toBe('e');
    });
  });

  it('returns undefined when nothing matches', () => {
    expect(pick([], req('GET', '/'))).toBeUndefined();
    expect(
      pick([{ id: 'post', ...base, path: '/orders', method: 'POST' }], req('GET', '/orders')),
    ).toBeUndefined();
  });

  it('returns a frozen copy of the rule as configured, not normalised', () => {
    const rule: Rule = { id: 'a', ...base, path: '/Orders', method: 'post' };
    const matched = createMatcher([rule])(req('POST', '/orders'), undefined);
    expect(matched).toStrictEqual(rule);
    expect(Object.isFrozen(matched)).toBe(true);
  });

  it("isn't changed by the caller changing a rule after it was validated", () => {
    const rule = { id: 'a', ...base, path: '/orders' };
    const match = createMatcher([rule]);
    rule.path = '/elsewhere';
    rule.limit = -1;
    expect(match(req('GET', '/orders'), undefined)).toMatchObject({ path: '/orders', limit: 10 });
  });
});
