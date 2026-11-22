import { createHash } from 'node:crypto';
import type { Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import Redis from 'ioredis';
import { parseTrustedHops, pickClientAddress } from './client-address';
import { env } from './env';
import type { AppEnv } from './types';

const trustedHops = parseTrustedHops(env.TRUST_PROXY);

export const rateLimitStore = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 1, commandTimeout: 2000 });
rateLimitStore.on('error', () => console.error(JSON.stringify({ level: 'error', event: 'rate_limit.storage_error' })));

// Atomic fixed windows shared by all API replicas. Keys never contain credentials or IPs.
const script = `local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return n`;
// Two buckets, both in the same hash slot (the prefix carries the hash tag): the first (tenant) is always charged; the
// second (project) only when the first admits. Returns {first, second}, second = -1 when the first refused.
const viewerScript = `local t = redis.call('INCR', KEYS[1])
if t == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
if t > tonumber(ARGV[2]) then return {t, -1} end
local p = redis.call('INCR', KEYS[2])
if p == 1 then redis.call('PEXPIRE', KEYS[2], ARGV[1]) end
return {t, p}`;
/**
 * The client address we can trust: with TRUST_PROXY hops, the X-Forwarded-For entry written by the outermost
 * trusted proxy (see client-address.ts); otherwise the socket peer. Used for rate limits, audit context and the
 * sign-in email's "requested from" hint.
 */
export function clientAddress(c: Context): string | undefined {
  const peer = (c.env as { incoming?: { socket: { remoteAddress?: string } } })?.incoming?.socket.remoteAddress;
  return pickClientAddress(c.req.header('x-forwarded-for'), peer, trustedHops);
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

// Only state-changing auth calls (send code, sign in, accept…) are limited; session reads happen on every navigation.
export const rateLimit = createMiddleware((c, next) => {
  if (/^\/api\/(?:auth|sessions?)\//.test(c.req.path)) return c.req.method === 'GET' ? next() : authLimiter(c, next);
  return next();
});

/** Injectable store/clock keep tests isolated without changing process configuration. */
export function createPublicRateLimits({
  store = rateLimitStore,
  prefix = env.BULLMQ_PREFIX,
  ingestLimit = env.INGEST_RATE_LIMIT_PER_MINUTE,
  readLimit = env.READ_RATE_LIMIT_PER_MINUTE,
  peerLimit = env.PUBLIC_RATE_LIMIT_PER_MINUTE,
  mintLimit = env.VIEWER_TOKEN_MINT_RATE_LIMIT_PER_MINUTE,
  viewerReadLimit = env.VIEWER_READ_RATE_LIMIT_PER_MINUTE,
  now = Date.now,
}: {
  store?: Pick<Redis, 'eval' | 'get'>;
  prefix?: string;
  ingestLimit?: number;
  readLimit?: number;
  peerLimit?: number;
  mintLimit?: number;
  viewerReadLimit?: number;
  now?: () => number;
} = {}) {
  const window = () => Math.floor(now() / 60_000);
  /** Seconds until the end of `minute` (default: the current window), at least 1. */
  const retryAfter = (minute = window()) => Math.max(1, Math.ceil(((minute + 1) * 60_000 - now()) / 1000));
  const peerKey = (c: Context, minute = window()) =>
    `${prefix}:rate:public-failures:${createHash('sha256')
      .update(clientAddress(c) || 'unknown')
      .digest('hex')}:${minute}`;
  const storageError = () => console.error(JSON.stringify({ level: 'error', event: 'rate_limit.storage_error' }));
  const denied = (c: Context, minute?: number) => {
    c.header('Retry-After', String(retryAfter(minute)));
    return c.json({ error: { code: 'rate_limited', message: 'Too many requests. Retry shortly.' } }, 429);
  };
  return {
    /**
     * Only credentials which cannot authenticate can be rejected before lookup. Returns the 429 response (computed from
     * the window it looked up, so a rollover never advertises a fresh minute) or null to continue.
     */
    async precheck(c: Context) {
      const minute = window();
      try {
        return Number(await store.get(peerKey(c, minute))) >= peerLimit ? denied(c, minute) : null;
      } catch {
        storageError();
        return null;
      }
    },
    async reject(c: Context) {
      try {
        const minute = window();
        if (Number(await store.eval(script, 1, peerKey(c, minute), 120_000)) > peerLimit) return denied(c, minute);
      } catch {
        storageError();
      }
      return c.json({ error: { code: 'invalid_api_key', message: 'A valid API key is required.' } }, 401);
    },
    denied,
    /** Viewer-token minting per key (#138). */
    mint: () =>
      createMiddleware<AppEnv>(async (c, next) => {
        try {
          const minute = window();
          const key = `${prefix}:rate:mint:${c.get('reader').keyId}:${minute}`;
          const count = Number(await store.eval(script, 1, key, 120_000));
          c.header('RateLimit-Limit', String(mintLimit));
          c.header('RateLimit-Remaining', String(Math.max(0, mintLimit - count)));
          c.header('RateLimit-Reset', String(retryAfter(minute)));
          if (count > mintLimit) return denied(c, minute);
        } catch {
          storageError();
        }
        await next();
      }),
    authenticated: (kind: 'ingest' | 'read') =>
      createMiddleware<AppEnv>(async (c, next) => {
        const limit = kind === 'ingest' ? ingestLimit : readLimit;
        const minute = window(); // one window for both buckets, even across a minute boundary
        const projectKey = `${prefix}:rate:project:${c.get('project').id}:${kind}:${minute}`;
        const reader = kind === 'read' ? c.get('reader') : undefined;
        try {
          if (reader?.via === 'token') {
            // #138: a viewer-token read is charged to its minting key + tenant bucket first, and to the project only
            // when that bucket admits it (one atomic script), so a throttled tenant can't drain other tenants' budget.
            const tenant = createHash('sha256')
              .update(reader.scope?.tenantId ?? '')
              .digest('hex')
              .slice(0, 32);
            const [tenantCount, projectCount] = (await store.eval(
              viewerScript,
              2,
              `${prefix}:rate:viewer:${reader.keyId}:${tenant}:${minute}`,
              projectKey,
              120_000,
              viewerReadLimit,
            )) as [number, number];
            const tenantRemaining = Math.max(0, viewerReadLimit - Number(tenantCount));
            const projectRemaining = Number(projectCount) < 0 ? limit : Math.max(0, limit - Number(projectCount));
            // RateLimit-* report the tighter bucket.
            const tighter = tenantRemaining <= projectRemaining;
            c.header('RateLimit-Limit', String(tighter ? viewerReadLimit : limit));
            c.header('RateLimit-Remaining', String(tighter ? tenantRemaining : projectRemaining));
            c.header('RateLimit-Reset', String(retryAfter(minute)));
            if (Number(projectCount) < 0 || Number(projectCount) > limit) return denied(c, minute);
            return next();
          }
          const count = Number(await store.eval(script, 1, projectKey, 120_000));
          c.header('RateLimit-Limit', String(limit));
          c.header('RateLimit-Remaining', String(Math.max(0, limit - count)));
          c.header('RateLimit-Reset', String(retryAfter(minute)));
          if (count > limit) return denied(c, minute);
        } catch {
          storageError();
        }
        await next();
      }),
  };
}
export const publicRateLimits = createPublicRateLimits();
