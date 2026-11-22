import { prisma } from '@logbird/database';
import { createMiddleware } from 'hono/factory';
import { ApiError } from '../errors';
import { API_KEY_BODY, hashApiKey } from '../keys';
import { publicRateLimits } from '../rate-limit';
import { keyUsable, type Reader, scopeWithin, storedScope, tokenKey, VIEWER_TOKEN_PREFIX, verifyViewerToken } from '../read-access';
import type { AppEnv } from '../types';

const touch = (id: string, userAgent: string | undefined) =>
  prisma.apiKey.updateMany({
    where: { id, revokedAt: null, OR: [{ lastUsedAt: null }, { lastUsedAt: { lt: new Date(Date.now() - 60_000) } }] },
    // Sampled with lastUsedAt (at most once a minute): tells owners which client still uses a key before they revoke it.
    data: { lastUsedAt: new Date(), lastUsedUserAgent: userAgent?.slice(0, 256) || null },
  });

/**
 * /v1 read authentication (#138): a `read` or `scoped-read` key, or (with `tokens`) a viewer token
 * `Authorization: Bearer lbv1…`. Sets `project` and `reader` (with the enforced scope). Unknown, revoked or expired
 * credentials answer 401 like any invalid key. A viewer token used from a browser origin that is not on its key's
 * `embedOrigins` answers 403 before any work is done.
 */
export const requireReader = ({ tokens = true, limits = publicRateLimits } = {}) =>
  createMiddleware<AppEnv>(async (c, next) => {
    const bearer = c.req.header('authorization')?.match(/^Bearer (\S+)$/)?.[1];
    if (bearer?.startsWith(`${VIEWER_TOKEN_PREFIX}.`)) {
      const payload = verifyViewerToken(bearer);
      const key = payload ? await tokenKey(payload.kid) : null;
      const keyScope = key ? storedScope(key) : undefined;
      if (
        !payload ||
        !key ||
        key.kind !== 'read' ||
        key.projectId !== payload.p ||
        !keyUsable(key) ||
        keyScope === undefined ||
        !scopeWithin(payload.s, keyScope)
      )
        return limits.reject(c);
      // Only a valid token reaches this: it authenticates, but may not mint (403), whatever its origin.
      if (!tokens) throw new ApiError(403, 'forbidden', 'Viewer tokens cannot mint viewer tokens. Use a read key.');
      const origin = c.req.header('origin');
      if (origin && !key.embedOrigins.includes(origin))
        throw new ApiError(403, 'origin_not_allowed', 'This origin is not allowed to use viewer tokens of this key.');
      await touch(key.id, c.req.header('user-agent'));
      c.set('project', key.project);
      c.set('reader', {
        via: 'token',
        keyId: key.id,
        keyName: key.name,
        scope: payload.s,
        embedOrigins: key.embedOrigins,
        jti: payload.jti,
      } satisfies Reader);
      return next();
    }
    const secret = bearer?.match(new RegExp(`^(?:lb|tm)_read_${API_KEY_BODY}$`))?.[0];
    if (!secret) {
      const exhausted = await limits.precheck(c);
      if (exhausted) return exhausted;
      return limits.reject(c);
    }
    const key = await prisma.apiKey.findUnique({ where: { hash: hashApiKey(secret) }, include: { project: true } });
    if (!key) return limits.reject(c);
    const scope = storedScope(key);
    if (key.kind !== 'read' || !keyUsable(key) || scope === undefined) return limits.reject(c);
    await touch(key.id, c.req.header('user-agent'));
    c.set('project', key.project);
    c.set('reader', { via: 'key', keyId: key.id, keyName: key.name, scope, embedOrigins: key.embedOrigins } satisfies Reader);
    await next();
  });
