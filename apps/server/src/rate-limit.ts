import { createHash } from 'node:crypto';
import type { Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import Redis from 'ioredis';
import { env } from './env';

export const rateLimitStore = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 1, commandTimeout: 2000 });
rateLimitStore.on('error', () => console.error(JSON.stringify({ level: 'error', event: 'rate_limit.storage_error' })));

// Atomic fixed windows shared by all API replicas. Keys never contain credentials or IPs.
const script = `local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return n`;
/**
 * The client address we can trust: with TRUST_PROXY the rightmost X-Forwarded-For entry (appended by our single
 * trusted proxy; leftmost entries are client-controlled), otherwise the socket peer. Used for rate limits, audit
 * context and the sign-in email's "requested from" hint.
 */
export function clientAddress(c: Context): string | undefined {
  return env.TRUST_PROXY === 'true'
    ? c.req.header('x-forwarded-for')?.split(',').at(-1)?.trim() || undefined
    : (c.env as { incoming?: { socket: { remoteAddress?: string } } })?.incoming?.socket.remoteAddress;
}
export function requestRateLimit(scope: string, limit: number, windowMs = 60_000, failOpen = false) {
  return createMiddleware(async (c, next) => {
    const peer = clientAddress(c);
    const digest = createHash('sha256')
      .update(peer || 'unknown')
      .digest('hex');
    const key = `${env.BULLMQ_PREFIX}:rate:${scope}:${c.req.method}:${c.req.routePath}:${digest}:${Math.floor(Date.now() / windowMs)}`;
    try {
      const count = Number(await rateLimitStore.eval(script, 1, key, windowMs * 2));
      if (count > limit) {
        c.header('Retry-After', String(Math.ceil(windowMs / 1000)));
        return c.json({ error: { code: 'rate_limited', message: 'Too many requests. Retry shortly.' } }, 429);
      }
    } catch {
      // Ingest must keep accepting audit events if the limiter store blips; auth fails closed.
      if (failOpen) return next();
      return c.json({ error: { code: 'rate_limit_unavailable', message: 'Request protection unavailable. Retry shortly.' } }, 503);
    }
    await next();
  });
}
const authLimiter = requestRateLimit('auth', env.AUTH_RATE_LIMIT_PER_MINUTE);
const publicLimiter = requestRateLimit('public', env.PUBLIC_RATE_LIMIT_PER_MINUTE, 60_000, true);
// Only state-changing auth calls (send code, sign in, accept…) are limited; session reads happen on every navigation.
export const rateLimit = createMiddleware((c, next) => {
  if (c.req.path.startsWith('/api/auth/')) return c.req.method === 'GET' ? next() : authLimiter(c, next);
  return publicLimiter(c, next);
});
