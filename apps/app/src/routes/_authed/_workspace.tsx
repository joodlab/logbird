import { createFileRoute, Outlet, redirect } from '@tanstack/react-router';
import { useEffect } from 'react';
import { toast } from 'sonner';
import { lostTitle, useLostWorkspaces } from '@/components/lost-workspaces';
import { FullPageLoader } from '@/components/route-states';
import { ensureActiveWorkspace } from '@/lib/session';

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

/** Says once, by name, which of the person's workspaces they no longer belong to (#4). */
function WorkspaceLayout() {
  const { workspace, me } = Route.useRouteContext();
  const lost = useLostWorkspaces(me);
  useEffect(() => {
    if (lost.length)
      toast.info(lostTitle(lost), {
        description: `You are in ${workspace.name}. To return, ask an owner or admin there to invite you again.`,
        duration: 12_000,
      });
  }, [lost, workspace.name]);
  return <Outlet />;
}
