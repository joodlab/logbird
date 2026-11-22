import { createFileRoute, redirect } from '@tanstack/react-router';

/** Moved to Workspace settings (/workspace/members): links and bookmarks to the old project URL still land there. */
export const Route = createFileRoute('/_authed/_workspace/p/$projectId/settings/members')({
  beforeLoad: () => {
    throw redirect({ to: '/workspace/members', replace: true });
  },
});
