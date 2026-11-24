import { createFileRoute, notFound, redirect } from '@tanstack/react-router';
import { ApiRequestError } from '@/lib/api/errors';
import { meQuery, projectQuery } from '@/lib/api/queries';
import { PROJECT_MISSING, projectElsewhere, withOpenWorkspace } from '@/lib/project-listed';

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
      if (elsewhere) throw notFound({ data: await withOpenWorkspace(context.queryClient, elsewhere) });
      if (error instanceof ApiRequestError && (error.status === 404 || error.status === 403)) throw notFound({ data: PROJECT_MISSING });
      throw error;
    }
    // The fresh read succeeded, so the project was in the workspace the session had open (the server checks that). This
    // tab's idea of the open workspace may be older (another tab switched it), so `me` is read again, and the redirect
    // runs only if the project is still in the workspace now open: a switch between the two reads is not found, never
    // another workspace's members.
    const me = await context.queryClient.fetchQuery({ ...meQuery(), staleTime: 0 });
    if (me.activeOrganizationId !== project.organizationId) throw notFound({ data: PROJECT_MISSING });
    throw redirect({ to: '/workspace/members', search: (prev) => ({ ...prev, ...search }), replace: true });
  },
});
