// Links from the write-up to the decision records it rests on (spec T7: every claim links to
// one). The ids are a type, so a link to a record that doesn't exist fails typecheck, and
// test/demo/records.test.ts checks this list against docs/decisions/. Record.tsx draws the links.
import { REPO_URL } from '../links.ts';

export const RECORDS = {
  '0001': '0001-async-algorithm-interface',
  '0002': '0002-hash-api-keys',
  '0003': '0003-reset-semantics',
  '0004': '0004-limit-in-app-middleware',
  '0005': '0005-metrics-through-hooks',
  '0006': '0006-atomic-lua-checks',
  '0007': '0007-redis-server-time',
  '0008': '0008-sliding-window-accuracy-vs-cost',
  '0009': '0009-latency-budget-prefetch',
  '0010': '0010-fail-open-with-local-fallback',
  '0011': '0011-match-paths-like-express',
  '0012': '0012-rate-limit-header-format',
  '0013': '0013-bring-your-own-redis-client',
  '0014': '0014-leaky-bucket-as-gcra',
  '0015': '0015-rules-files',
  '0016': '0016-switching-algorithms-starts-fresh',
  '0017': '0017-how-the-benchmarks-measure',
  '0018': '0018-timeout-and-fallback-in-the-middleware',
  '0019': '0019-hook-events',
  '0020': '0020-ipv6-by-64',
  '0021': '0021-per-request-timing-tolerance',
  '0022': '0022-burst',
  '0023': '0023-algorithm-per-rule',
  '0024': '0024-demo-runs-the-shipped-lua',
  '0025': '0025-publish-from-ci-with-provenance',
  '0026': '0026-no-unverified-api-keys',
  '0027': '0027-match-paths-as-handlers-read-them',
  '0028': '0028-key-prefix-per-limiter',
  '0029': '0029-ipv4-in-ipv6-and-non-ip-values',
  '0030': '0030-match-dot-dot-both-ways',
  '0031': '0031-two-rules-on-one-key',
  '0032': '0032-unknown-fields-throw-in-code-too',
  '0033': '0033-mutation-testing',
  '0034': '0034-property-tests',
  '0035': '0035-folder-urls-with-a-cloudfront-function',
} as const;

export type RecordId = keyof typeof RECORDS;

export const recordUrl = (id: RecordId) => `${REPO_URL}/blob/main/docs/decisions/${RECORDS[id]}.md`;
