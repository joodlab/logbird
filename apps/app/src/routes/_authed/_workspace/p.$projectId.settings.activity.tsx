import { createFileRoute, redirect } from '@tanstack/react-router';
import { z } from 'zod';

/**
 * Moved to Workspace settings (/workspace/activity): links and bookmarks to the old project URL still land there, with
 * their search (range, query and the open event) intact.
 */
export const Route = createFileRoute('/_authed/_workspace/p/$projectId/settings/activity')({
  validateSearch: z.object({ q: z.string().optional(), ev: z.string().optional() }),
  beforeLoad: ({ search }) => {
    throw redirect({ to: '/workspace/activity', search: (prev) => ({ ...prev, ...search }), replace: true });
  },
});
