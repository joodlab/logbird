import { createFileRoute, redirect } from '@tanstack/react-router';
import { FullPageLoader } from '@/components/route-states';
import { projectsQuery } from '@/lib/api/queries';
import { lastProject, requireMe } from '@/lib/session';

/** `/` sends people to their last project, the onboarding step they are missing, or sign-in. */
export const Route = createFileRoute('/')({
  beforeLoad: async ({ context }) => {
    const me = await requireMe(context.queryClient);
    if (me.organizations.length === 0) throw redirect({ to: '/onboarding' });
    const projects = await context.queryClient.ensureQueryData(projectsQuery());
    if (projects.length === 0) throw redirect({ to: '/onboarding/project' });
    const remembered = lastProject();
    const target = projects.find((p) => p.id === remembered) ?? projects[0];
    throw redirect({ to: '/p/$projectId', params: { projectId: target?.id ?? '' } });
  },
  pendingComponent: FullPageLoader,
  component: FullPageLoader,
});
