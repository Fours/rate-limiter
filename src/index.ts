// The main entry point. Everything public is exported from here, except prometheusHooks, which
// has its own entry point, prometheus.ts, so this one never loads prom-client.
export type { Algorithm, Clock, Decision, Rule } from './types.js';
export { systemClock } from './clock.js';
export { createTokenBucket } from './algorithms/token-bucket.js';
export type { TokenBucket, TokenBucketOptions } from './algorithms/token-bucket.js';
export { buildKey, defaultIdentify } from './identify.js';
export type { IdentifiableRequest } from './identify.js';
export { rateLimit } from './middleware.js';
export type { FallbackOptions, RateLimitMiddleware, RateLimitOptions } from './middleware.js';
export { RateLimitTimeoutError } from './timeout.js';
export type { DecisionEvent, FallbackEvent, RateLimitHooks } from './hooks.js';
export { InvalidRuleError } from './rules.js';
export { loadRules, parseRules } from './rules-file.js';
export type { RulesFormat } from './rules-file.js';
export { fromIoredis, fromNodeRedis } from './redis/client.js';
export type { IoredisLike, NodeRedisLike, RedisScriptClient } from './redis/client.js';
export { createRedisTokenBucket } from './algorithms/redis/token-bucket.js';
export { createRedisFixedWindow } from './algorithms/redis/fixed-window.js';
export { createRedisSlidingWindowLog } from './algorithms/redis/sliding-window-log.js';
export { createRedisSlidingWindowCounter } from './algorithms/redis/sliding-window-counter.js';
export { createRedisLeakyBucket } from './algorithms/redis/leaky-bucket.js';
export type { RedisAlgorithmOptions } from './algorithms/redis/factory.js';
