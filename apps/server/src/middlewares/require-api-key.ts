import { prisma } from '@logbird/database';
import { createMiddleware } from 'hono/factory';
import { hashApiKey } from '../keys';
import { publicRateLimits } from '../rate-limit';
import type { AppEnv } from '../types';
export const requireApiKey = (kind: 'ingest' | 'read', limits = publicRateLimits) =>
  createMiddleware<AppEnv>(async (c, next) => {
    const secret = c.req.header('authorization')?.match(/^Bearer ((?:lb|tm)_(?:ingest|read)_[A-Za-z0-9]{32})$/)?.[1];
    if (!secret || !new RegExp(`^(?:lb|tm)_${kind}_`).test(secret)) {
      if (await limits.precheck(c)) return limits.denied(c);
      return limits.reject(c);
    }
    const key = await prisma.apiKey.findUnique({ where: { hash: hashApiKey(secret) }, include: { project: true } });
    if (!key || key.revokedAt || key.kind !== kind) return limits.reject(c);
    await prisma.apiKey.updateMany({
      where: { id: key.id, revokedAt: null, OR: [{ lastUsedAt: null }, { lastUsedAt: { lt: new Date(Date.now() - 60_000) } }] },
      // Sampled with lastUsedAt (at most once a minute): tells owners which client still uses a key before they revoke it.
      data: { lastUsedAt: new Date(), lastUsedUserAgent: c.req.header('user-agent')?.slice(0, 256) || null },
    });
    c.set('project', key.project);
    await next();
  });
