import { createFileRoute, notFound, redirect } from '@tanstack/react-router';
import { z } from 'zod';
import { ApiRequestError } from '@/lib/api/errors';
import { projectQuery } from '@/lib/api/queries';

/**
 * Moved to Workspace settings (/workspace/activity): links and bookmarks to the old project URL still land there, with
 * their search (range, query and the open event) intact. The project is checked first, as before the move: a project
 * outside the active workspace stays "not found" instead of opening another workspace's activity.
 */
export const Route = createFileRoute('/_authed/_workspace/p/$projectId/settings/activity')({
  validateSearch: z.object({ q: z.string().optional(), ev: z.string().optional() }),
  beforeLoad: async ({ context, params, search }) => {
    try {
      await context.queryClient.ensureQueryData(projectQuery(params.projectId));
    } catch (error) {
      if (error instanceof ApiRequestError && (error.status === 404 || error.status === 403)) throw notFound();
      throw error;
    }
    throw redirect({ to: '/workspace/activity', search: (prev) => ({ ...prev, ...search }), replace: true });
  },
});
