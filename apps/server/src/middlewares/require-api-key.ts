import { prisma } from '@trailmark/database';
import { createMiddleware } from 'hono/factory';
import { ApiError } from '../errors';
import { hashApiKey } from '../keys';
import type { AppEnv } from '../types';
export const requireApiKey = (kind: 'ingest' | 'read') =>
  createMiddleware<AppEnv>(async (c, next) => {
    const secret = c.req.header('authorization')?.match(/^Bearer (tm_(?:ingest|read)_[A-Za-z0-9]{32})$/)?.[1];
    if (!secret?.startsWith(`tm_${kind}_`)) throw new ApiError(401, 'invalid_api_key', 'A valid API key is required.');
    const key = await prisma.apiKey.findUnique({ where: { hash: hashApiKey(secret) }, include: { project: true } });
    if (!key || key.revokedAt || key.kind !== kind) throw new ApiError(401, 'invalid_api_key', 'A valid API key is required.');
    await prisma.apiKey.updateMany({
      where: { id: key.id, revokedAt: null, OR: [{ lastUsedAt: null }, { lastUsedAt: { lt: new Date(Date.now() - 60_000) } }] },
      data: { lastUsedAt: new Date() },
    });
    c.set('project', key.project);
    await next();
  });
