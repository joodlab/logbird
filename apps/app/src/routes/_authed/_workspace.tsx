import { createFileRoute, Outlet, redirect } from '@tanstack/react-router';
import { useEffect } from 'react';
import { toast } from 'sonner';
import { FullPageLoader } from '@/components/route-states';
import { ensureActiveWorkspace, takeLostWorkspace } from '@/lib/session';

/** Requires an active workspace (organization). People without one go to onboarding. */
export const Route = createFileRoute('/_authed/_workspace')({
  beforeLoad: async ({ context }) => {
    // Before any redirect: it notes a workspace this person no longer belongs to, so the next page can say so.
    const me = await ensureActiveWorkspace(context.queryClient, context.me);
    if (me.organizations.length === 0) throw redirect({ to: '/onboarding' });
    const workspace = me.organizations.find((o) => o.id === me.activeOrganizationId) ?? me.organizations[0];
    if (!workspace) throw redirect({ to: '/onboarding' });
    return { me, workspace };
  },
  pendingComponent: FullPageLoader,
  component: WorkspaceLayout,
});

/** Says once, by name, that the workspace this browser last showed is no longer one of the person's (#4). */
function WorkspaceLayout() {
  const { workspace } = Route.useRouteContext();
  useEffect(() => {
    const lost = takeLostWorkspace();
    if (lost)
      toast.info(`You no longer have access to ${lost}`, {
        description: `An owner removed you, or the workspace was deleted. You are in ${workspace.name}; ask an owner of ${lost} to invite you again.`,
        duration: 12_000,
      });
  }, [workspace.name]);
  return <Outlet />;
}
