import { createFileRoute, notFound, redirect } from '@tanstack/react-router';
import { ApiRequestError } from '@/lib/api/errors';
import { projectQuery } from '@/lib/api/queries';
import { PROJECT_MISSING, projectElsewhere } from '@/lib/project-listed';

/**
 * Moved to Workspace settings (/workspace/members): links and bookmarks to the old project URL still land there, with their range.
 * The project is fetched fresh (never from another tab's cache) and must belong to the active workspace, as it had to
 * before the move: a project outside it stays "not found" instead of opening another workspace's members.
 */
export const Route = createFileRoute('/_authed/_workspace/p/$projectId/settings/members')({
  beforeLoad: async ({ context, params, search }) => {
    let project: { organizationId: string };
    try {
      project = await context.queryClient.fetchQuery({ ...projectQuery(params.projectId), staleTime: 0 });
    } catch (error) {
      // A project in another of the person's workspaces: the project page's switch prompt, not an error.
      const elsewhere = projectElsewhere(error);
      if (elsewhere) throw notFound({ data: elsewhere });
      if (error instanceof ApiRequestError && (error.status === 404 || error.status === 403)) throw notFound({ data: PROJECT_MISSING });
      throw error;
    }
    if (project.organizationId !== context.workspace.id) throw notFound({ data: PROJECT_MISSING });
    throw redirect({ to: '/workspace/members', search: (prev) => ({ ...prev, ...search }), replace: true });
  },
});
