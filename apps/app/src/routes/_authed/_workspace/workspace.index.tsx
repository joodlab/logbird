import { createFileRoute, redirect } from '@tanstack/react-router';

/** /workspace opens its first section. */
export const Route = createFileRoute('/_authed/_workspace/workspace/')({
  beforeLoad: () => {
    throw redirect({ to: '/workspace/members', replace: true });
  },
});
