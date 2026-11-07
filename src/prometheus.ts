// The second entry point, @kylewillett/rate-limiter/prometheus. The only module that imports
// prom-client, an optional peer dependency, so the main entry never loads it (decision 0005).
import { Counter, Histogram, register, type Registry } from 'prom-client';
import type { RateLimitHooks } from './hooks.js';

export interface PrometheusHooksOptions {
  /** Where the metrics are registered. Default: prom-client's global registry. */
  readonly registry?: Registry;
  /** Put in front of every metric name. Default `ratelimit_`. */
  readonly prefix?: string;
  /** Histogram buckets for `{prefix}check_seconds`, in seconds, strictly increasing. */
  readonly buckets?: readonly number[];
}

/** 0.1 ms to 100 ms: checks take about 0.2 ms at p50 (0008), and time out at 50 ms by default. */
export const DEFAULT_BUCKETS: readonly number[] = [
  0.0001, 0.00025, 0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1,
];

const METRIC_NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;

/**
 * Hooks that record every decision and fallback as Prometheus metrics. Labels are rule IDs and
 * fixed values only, never clients, so the number of series is bounded by the rules.
 *
 * Call it once per registry and share the result: a second call on the same registry throws.
 */
export function prometheusHooks(options: PrometheusHooksOptions = {}): RateLimitHooks {
  const registry = resolveRegistry(options.registry);
  const prefix = resolvePrefix(options.prefix);
  const buckets = resolveBuckets(options.buckets);

  const names = {
    decisions: `${prefix}decisions_total`,
    fallbacks: `${prefix}fallback_total`,
    check: `${prefix}check_seconds`,
  };
  // prom-client throws on the first duplicate it meets, after registering the metrics before it.
  // Checking every name first means a failed call leaves the registry as it was.
  for (const name of Object.values(names)) {
    if (registry.getSingleMetric(name) !== undefined) {
      throw new Error(
        `prometheusHooks: ${name} is already registered on this registry. ` +
          'Call prometheusHooks() once per registry and share the hooks it returns.',
      );
    }
  }

  const registers = [registry];
  const decisions = new Counter({
    name: names.decisions,
    help: 'Rate limit decisions, by rule, outcome and where the decision came from.',
    labelNames: ['rule', 'outcome', 'source'] as const,
    registers,
  });
  const fallbacks = new Counter({
    name: names.fallbacks,
    help: 'Checks answered by the in-memory fallback, by rule and reason.',
    labelNames: ['rule', 'reason'] as const,
    registers,
  });
  const check = new Histogram({
    name: names.check,
    help: 'Time spent in the rate limiter per request, in seconds.',
    labelNames: ['rule', 'source'] as const,
    buckets: [...buckets],
    registers,
  });

  return {
    onDecision: ({ rule, decision, source, durationMs }) => {
      decisions.inc({ rule: rule.id, outcome: decision.allowed ? 'allowed' : 'denied', source });
      check.observe({ rule: rule.id, source }, durationMs / 1000);
    },
    onFallback: ({ rule, reason }) => {
      fallbacks.inc({ rule: rule.id, reason });
    },
  };
}

function resolveRegistry(value: unknown): Registry {
  if (value === undefined) return register;
  // Shape, not instanceof: with two copies of prom-client installed, a real registry from the
  // other copy would fail instanceof.
  if (
    typeof value !== 'object' ||
    value === null ||
    !('getSingleMetric' in value) ||
    typeof value.getSingleMetric !== 'function' ||
    !('registerMetric' in value) ||
    typeof value.registerMetric !== 'function'
  ) {
    throw new TypeError('prometheusHooks: registry must be a prom-client Registry');
  }
  return value as Registry;
}

function resolvePrefix(value: unknown): string {
  if (value === undefined) return 'ratelimit_';
  // An empty prefix is fine: the names it gives, such as decisions_total, are valid.
  if (typeof value !== 'string' || (value !== '' && !METRIC_NAME.test(value))) {
    throw new TypeError(
      'prometheusHooks: prefix must be a string of letters, digits, _ and :, not starting with a digit',
    );
  }
  return value;
}

/** prom-client accepts any array, but unsorted buckets give wrong counts, so check here. */
function resolveBuckets(value: unknown): readonly number[] {
  if (value === undefined) return DEFAULT_BUCKETS;
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError('prometheusHooks: buckets must be a non-empty array of numbers');
  }
  const buckets: unknown[] = value;
  let previous = 0;
  for (const bucket of buckets) {
    if (typeof bucket !== 'number' || !Number.isFinite(bucket) || bucket <= previous) {
      throw new RangeError(
        'prometheusHooks: buckets must be finite, positive and strictly increasing',
      );
    }
    previous = bucket;
  }
  return buckets as number[];
}
