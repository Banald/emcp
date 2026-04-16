import type { Redis } from 'ioredis';
import { ValidationError } from '../lib/errors.ts';

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAtMs: number;
  retryAfterSec?: number;
}

export interface RateLimitInput {
  scope: string;
  limit: number;
  windowMs: number;
}

export interface RateLimiter {
  check(input: RateLimitInput): Promise<RateLimitResult>;
}

// Lua script for atomic sliding window rate limiting.
// Uses a sorted set where each member is a unique request ID scored by timestamp.
// KEYS[1] = scope key
// ARGV[1] = window_ms, ARGV[2] = limit, ARGV[3] = now_ms
const SLIDING_WINDOW_LUA = `
local key = KEYS[1]
local window = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local now = tonumber(ARGV[3])

redis.call('ZREMRANGEBYSCORE', key, '-inf', now - window)
local count = redis.call('ZCARD', key)
if count < limit then
  redis.call('ZADD', key, now, now .. ':' .. math.random(1000000))
  redis.call('PEXPIRE', key, window)
  return {1, limit - count - 1, now}
else
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  return {0, 0, tonumber(oldest[2])}
end
`;

function validateInput(input: RateLimitInput): void {
  if (!Number.isFinite(input.limit) || input.limit < 1) {
    throw new ValidationError(
      `rate limit must be a positive integer, got ${input.limit}`,
      'Invalid rate limit configuration.',
    );
  }
  if (!Number.isFinite(input.windowMs) || input.windowMs < 1) {
    throw new ValidationError(
      `window must be a positive integer in ms, got ${input.windowMs}`,
      'Invalid rate limit configuration.',
    );
  }
}

export function createRateLimiter(redis: Redis): RateLimiter {
  redis.defineCommand('slidingWindowRateLimit', {
    numberOfKeys: 1,
    lua: SLIDING_WINDOW_LUA,
  });

  return {
    async check(input: RateLimitInput): Promise<RateLimitResult> {
      validateInput(input);

      const now = Date.now();
      // ioredis custom commands are accessed via the instance dynamically
      const result = await (
        redis as Redis & {
          slidingWindowRateLimit: (
            key: string,
            ...args: (string | number)[]
          ) => Promise<[number, number, number]>;
        }
      ).slidingWindowRateLimit(input.scope, input.windowMs, input.limit, now);

      const [allowed, remaining, oldestOrNow] = result;

      if (allowed) {
        return {
          allowed: true,
          limit: input.limit,
          remaining,
          resetAtMs: now + input.windowMs,
        };
      }

      const resetAtMs = oldestOrNow + input.windowMs;
      const retryAfterSec = Math.ceil((resetAtMs - now) / 1000);

      return {
        allowed: false,
        limit: input.limit,
        remaining: 0,
        resetAtMs,
        retryAfterSec: Math.max(retryAfterSec, 1),
      };
    },
  };
}
