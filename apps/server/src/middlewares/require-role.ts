import { prisma } from '@logbird/database';
import type { Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import { ApiError } from '../errors';
import type { AppEnv } from '../types';
import { requireSession } from './require-session';

const all = ['owner', 'admin', 'member'] as const;
const admins = ['owner', 'admin'] as const;
// All console mutations must be listed here, including self-only session endpoints.
export const mutationPermissions = [
  { method: 'POST', path: /^\/api\/session\/sign-out$/, roles: all, self: true },
  { method: 'POST', path: /^\/api\/sessions\/revoke(?:-all|-others)?$/, roles: all, self: true },
  { method: 'PATCH', path: /^\/api\/workspace$/, roles: admins },
  { method: 'POST', path: /^\/api\/projects$/, roles: admins },
  { method: 'PATCH', path: /^\/api\/projects\/[^/]+$/, roles: admins },
  { method: 'DELETE', path: /^\/api\/projects\/[^/]+$/, roles: admins },
  { method: 'POST', path: /^\/api\/projects\/[^/]+\/keys$/, roles: admins },
  { method: 'DELETE', path: /^\/api\/projects\/[^/]+\/keys\/[^/]+$/, roles: admins },
  { method: 'POST', path: /^\/api\/projects\/[^/]+\/keys\/[^/]+\/roll$/, roles: admins },
  { method: 'POST', path: /^\/api\/projects\/[^/]+\/views$/, roles: all },
  { method: 'DELETE', path: /^\/api\/projects\/[^/]+\/views\/[^/]+$/, roles: all },
  { method: 'POST', path: /^\/api\/projects\/[^/]+\/sample-data$/, roles: admins },
  { method: 'DELETE', path: /^\/api\/projects\/[^/]+\/sample-data$/, roles: admins },
  { method: 'POST', path: /^\/api\/projects\/[^/]+\/test-event$/, roles: admins },
  { method: 'POST', path: /^\/api\/workspace\/invite-links$/, roles: admins },
  { method: 'DELETE', path: /^\/api\/workspace\/invite-links\/[^/]+$/, roles: admins },
] as const;

export const hasAdminRole = (role: string) => role.split(',').some((r) => admins.some((allowed) => allowed === r.trim()));
const forbidden = () => new ApiError(403, 'forbidden', 'Workspace owner or admin access required.');

export async function requireRole(c: Context<AppEnv>, roles: readonly string[] = admins, organizationId = c.get('activeOrganizationId')) {
  const member = organizationId ? await prisma.member.findFirst({ where: { organizationId, userId: c.get('user').id } }) : null;
  if (!member?.role.split(',').some((r) => roles.includes(r.trim()))) throw forbidden();
  return member;
}

export const authorizeMutation = createMiddleware<AppEnv>(async (c, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) return next();
  // This endpoint consumes a bearer invitation, with its own domain/expiry/use checks.
  if (c.req.method === 'POST' && /^\/api\/invite-links\/[^/]+\/accept$/.test(c.req.path)) return next();
  return requireSession(c, async () => {
    const permission = mutationPermissions.find((p) => p.method === c.req.method && p.path.test(c.req.path));
    if (!permission) throw forbidden();
    const projectId = c.req.path.match(/^\/api\/projects\/([^/]+)/)?.[1];
    let organizationId = c.get('activeOrganizationId');
    if (projectId) {
      const project = await prisma.project.findUnique({ where: { id: decodeURIComponent(projectId) } });
      if (!project || project.organizationId !== organizationId) throw new ApiError(404, 'not_found', 'Project not found.');
      organizationId = project.organizationId;
    }
    if (!('self' in permission && permission.self)) await requireRole(c, permission.roles, organizationId);
    await next();
  });
});
