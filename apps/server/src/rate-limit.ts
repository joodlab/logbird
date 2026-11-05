import { createHash } from 'node:crypto';
import { createMiddleware } from 'hono/factory';
import Redis from 'ioredis';
import { env } from './env';

export const rateLimitStore = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 1, commandTimeout: 2000 });
rateLimitStore.on('error', () => console.error(JSON.stringify({ level: 'error', event: 'rate_limit.storage_error' })));

// Atomic fixed windows shared by all API replicas. Keys never contain credentials or IPs.
const script = `local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return n`;
export function requestRateLimit(scope: string, limit: number, windowMs = 60_000, failOpen = false) {
  return createMiddleware(async (c, next) => {
    const peer =
      env.TRUST_PROXY === 'true'
        ? // Rightmost entry = the address our (single) trusted proxy appended; leftmost entries are client-controlled.
          c.req.header('x-forwarded-for')?.split(',').at(-1)?.trim()
        : (c.env as { incoming?: { socket: { remoteAddress?: string } } })?.incoming?.socket.remoteAddress;
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
const authLimiter = requestRateLimit('auth', 30);
const publicLimiter = requestRateLimit('public', 600, 60_000, true);
// Only state-changing auth calls (send code, sign in, accept…) are limited; session reads happen on every navigation.
export const rateLimit = createMiddleware((c, next) => {
  if (c.req.path.startsWith('/api/auth/')) return c.req.method === 'GET' ? next() : authLimiter(c, next);
  return publicLimiter(c, next);
});
