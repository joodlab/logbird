import { createFileRoute, notFound, redirect } from '@tanstack/react-router';
import { ApiRequestError } from '@/lib/api/errors';
import { projectQuery } from '@/lib/api/queries';

/**
 * Moved to Workspace settings (/workspace/members): links and bookmarks to the old project URL still land there. The
 * project is checked first, as before the move: a project outside the active workspace stays "not found" instead of
 * landing on another workspace's members.
 */
export const Route = createFileRoute('/_authed/_workspace/p/$projectId/settings/members')({
  beforeLoad: async ({ context, params }) => {
    try {
      await context.queryClient.ensureQueryData(projectQuery(params.projectId));
    } catch (error) {
      if (error instanceof ApiRequestError && (error.status === 404 || error.status === 403)) throw notFound();
      throw error;
    }
    throw redirect({ to: '/workspace/members', replace: true });
  },
});
