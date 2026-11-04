import { createFileRoute, Outlet, redirect } from '@tanstack/react-router';
import { FullPageLoader } from '@/components/route-states';
import { ensureActiveWorkspace } from '@/lib/session';

/** Requires an active workspace (organization). People without one go to onboarding. */
export const Route = createFileRoute('/_authed/_workspace')({
  beforeLoad: async ({ context }) => {
    if (context.me.organizations.length === 0) throw redirect({ to: '/onboarding' });
    const me = await ensureActiveWorkspace(context.queryClient, context.me);
    const workspace = me.organizations.find((o) => o.id === me.activeOrganizationId) ?? me.organizations[0];
    if (!workspace) throw redirect({ to: '/onboarding' });
    return { me, workspace };
  },
  pendingComponent: FullPageLoader,
  component: Outlet,
});
