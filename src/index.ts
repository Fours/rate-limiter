// The only public entry point: everything consumers can import is exported from here.
export type { Algorithm, Clock, Decision, Rule } from './types.js';
export { systemClock } from './clock.js';
export { createTokenBucket } from './algorithms/token-bucket.js';
export type { TokenBucket, TokenBucketOptions } from './algorithms/token-bucket.js';
export { buildKey, defaultIdentify } from './identify.js';
export type { IdentifiableRequest } from './identify.js';
export { rateLimit } from './middleware.js';
export type { RateLimitMiddleware, RateLimitOptions } from './middleware.js';
export { InvalidRuleError } from './rules.js';
export { fromIoredis, fromNodeRedis } from './redis/client.js';
export type { IoredisLike, NodeRedisLike, RedisScriptClient } from './redis/client.js';
export { createRedisTokenBucket } from './algorithms/redis/token-bucket.js';
export { createRedisFixedWindow } from './algorithms/redis/fixed-window.js';
export type { RedisAlgorithmOptions } from './algorithms/redis/factory.js';
