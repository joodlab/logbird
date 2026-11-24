import { PROJECT_IN_OTHER_WORKSPACE } from '@logbird/contracts';
import { prisma } from '@logbird/database';
import type { Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import { ApiError } from '../errors';
import type { AppEnv } from '../types';

/** The one answer for "no such project" and "a project in a workspace you are not a member of": nothing tells them apart. */
const notFound = () => new ApiError(404, 'not_found', 'Project not found.');

/**
 * The single project check for console (session) routes, used by requireProjectAccess and by authorizeMutation before
 * its role check. The project must be in the session's active workspace and the user a current member of it. A current
 * member of the workspace that owns the project, with another workspace active, gets 409 project_in_other_workspace
 * naming it, so the console can offer to switch; anyone else gets the same 404 as for a project that does not exist.
 */
export async function projectAccess(c: Context<AppEnv>, projectId: string) {
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  // The member lookup runs either way, so a missing project and one in a workspace the person is not in cost the same.
  const member = await prisma.member.findFirst({
    where: { organizationId: project?.organizationId ?? '', userId: c.get('user').id },
    select: { role: true },
  });
  if (!project || !member) throw notFound();
  if (project.organizationId !== c.get('activeOrganizationId')) {
    const workspace = await prisma.organization.findUnique({ where: { id: project.organizationId }, select: { id: true, name: true } });
    if (!workspace) throw notFound();
    throw new ApiError(409, PROJECT_IN_OTHER_WORKSPACE, `This project is in ${workspace.name}. Switch to that workspace to open it.`, {
      workspaceId: workspace.id,
      workspaceName: workspace.name,
    });
  }
  return { project, member };
}

/** Every console project route: mounted after requireSession on /api/projects/:projectId[/*] in each console router. */
export const requireProjectAccess = createMiddleware<AppEnv>(async (c, next) => {
  const { project, member } = await projectAccess(c, c.req.param('projectId') ?? '');
  c.set('project', project);
  c.set('member', { role: member.role });
  await next();
});
