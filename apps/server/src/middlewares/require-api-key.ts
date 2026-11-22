import { prisma } from '@logbird/database';
import { createMiddleware } from 'hono/factory';
import { API_KEY_BODY, hashApiKey } from '../keys';
import { publicRateLimits } from '../rate-limit';
import { keyUsable } from '../read-access';
import type { AppEnv } from '../types';
export const requireApiKey = (kind: 'ingest' | 'read', limits = publicRateLimits) =>
  createMiddleware<AppEnv>(async (c, next) => {
    const secret = c.req.header('authorization')?.match(new RegExp(`^Bearer ((?:lb|tm)_(?:ingest|read)_${API_KEY_BODY})$`))?.[1];
    if (!secret || !new RegExp(`^(?:lb|tm)_${kind}_`).test(secret)) {
      const exhausted = await limits.precheck(c);
      if (exhausted) return exhausted;
      return limits.reject(c);
    }
    const key = await prisma.apiKey.findUnique({ where: { hash: hashApiKey(secret) }, include: { project: true } });
    if (!key || !keyUsable(key) || key.kind !== kind || (kind === 'read' && key.scope !== null)) return limits.reject(c);
    await prisma.apiKey.updateMany({
      where: { id: key.id, revokedAt: null, OR: [{ lastUsedAt: null }, { lastUsedAt: { lt: new Date(Date.now() - 60_000) } }] },
      // Sampled with lastUsedAt (at most once a minute): tells owners which client still uses a key before they revoke it.
      data: { lastUsedAt: new Date(), lastUsedUserAgent: c.req.header('user-agent')?.slice(0, 256) || null },
    });
    c.set('project', key.project);
    await next();
  });
