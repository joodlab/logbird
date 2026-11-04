import { createFileRoute, Outlet } from '@tanstack/react-router';
import { FullPageLoader } from '@/components/route-states';
import { requireMe } from '@/lib/session';

/** Everything below requires a session; unauthenticated visitors go to /login?redirect=… */
export const Route = createFileRoute('/_authed')({
  beforeLoad: async ({ context, location }) => {
    const me = await requireMe(context.queryClient, location.href);
    return { me };
  },
  pendingComponent: FullPageLoader,
  component: Outlet,
});
