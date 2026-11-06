import { auth } from '@logbird/auth';
import { createMiddleware } from 'hono/factory';
import { ApiError } from '../errors';
import type { AppEnv } from '../types';
export const requireSession = createMiddleware<AppEnv>(async (c, next) => {
  const result = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!result) throw new ApiError(401, 'unauthorized', 'Sign in to continue.');
  c.set('user', result.user);
  c.set('session', result.session);
  c.set('activeOrganizationId', result.session.activeOrganizationId ?? null);
  await next();
});
