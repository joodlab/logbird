import { createFileRoute, Outlet, redirect } from '@tanstack/react-router';
import { FullPageLoader } from '@/components/route-states';
import { meQuery } from '@/lib/api/queries';
import { authClient } from '@/lib/auth-client';

/** Requires an active workspace (organization). People without one go to onboarding. */
export const Route = createFileRoute('/_authed/_workspace')({
  beforeLoad: async ({ context }) => {
    let me = context.me;
    if (me.organizations.length === 0) throw redirect({ to: '/onboarding' });
    if (!(me.activeOrganizationId && me.organizations.some((o) => o.id === me.activeOrganizationId))) {
      const first = me.organizations[0];
      if (first) {
        await authClient.organization.setActive({ organizationId: first.id });
        me = await context.queryClient.fetchQuery({ ...meQuery(), staleTime: 0 });
      }
    }
    const workspace = me.organizations.find((o) => o.id === me.activeOrganizationId) ?? me.organizations[0];
    if (!workspace) throw redirect({ to: '/onboarding' });
    return { me, workspace };
  },
  pendingComponent: FullPageLoader,
  component: Outlet,
});
