import { prisma } from '@trailmark/database';
import { createMiddleware } from 'hono/factory';
import { ApiError } from '../errors';
import type { AppEnv } from '../types';
export const requireProjectAccess = createMiddleware<AppEnv>(async (c, next) => {
  const project = await prisma.project.findUnique({ where: { id: c.req.param('projectId') ?? '' } });
  if (!project || project.organizationId !== c.get('activeOrganizationId')) throw new ApiError(404, 'not_found', 'Project not found.');
  const member = await prisma.member.findFirst({ where: { organizationId: project.organizationId, userId: c.get('user').id } });
  if (!member) throw new ApiError(404, 'not_found', 'Project not found.');
  c.set('project', project);
  c.set('member', { role: member.role });
  await next();
});
