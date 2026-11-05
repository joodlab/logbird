import { getConnInfo } from '@hono/node-server/conninfo';
import { createMiddleware } from 'hono/factory';
import { ApiError } from './errors';
import type { AppEnv } from './types';

// Per-process fixed window. Replace this module with shared storage for multi-instance deployments.
export function inviteRateLimit(limit = 30, windowMs = 60_000) {
  const buckets = new Map<string, { count: number; until: number }>();
  return createMiddleware<AppEnv>(async (c, next) => {
    const now = Date.now();
    for (const [key, bucket] of buckets) if (bucket.until <= now) buckets.delete(key);
    // Use the peer address, never a client-supplied forwarding header.
    const ip = (c.env ? getConnInfo(c).remote.address : undefined) ?? 'unknown';
    const key = `${c.req.method}:${c.req.routePath}:${ip}`;
    const bucket = buckets.get(key) ?? { count: 0, until: now + windowMs };
    buckets.set(key, bucket);
    if (++bucket.count > limit) {
      c.header('Retry-After', String(Math.ceil((bucket.until - now) / 1000)));
      throw new ApiError(429, 'rate_limited', 'Too many requests. Try again shortly.');
    }
    await next();
  });
}
export const limitInviteRequests = inviteRateLimit();
