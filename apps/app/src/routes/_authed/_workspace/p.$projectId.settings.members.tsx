import { createFileRoute, notFound, redirect } from '@tanstack/react-router';
import { ApiRequestError } from '@/lib/api/errors';
import { projectQuery } from '@/lib/api/queries';

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
      if (error instanceof ApiRequestError && (error.status === 404 || error.status === 403)) throw notFound();
      throw error;
    }
    if (project.organizationId !== context.workspace.id) throw notFound();
    throw redirect({ to: '/workspace/members', search: (prev) => ({ ...prev, ...search }), replace: true });
  },
});
