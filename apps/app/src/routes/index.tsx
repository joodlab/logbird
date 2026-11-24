import { createFileRoute, redirect } from '@tanstack/react-router';
import { FullPageLoader } from '@/components/route-states';
import { resolveOnboarding } from '@/lib/onboarding';
import { ensureActiveWorkspace, requireMe } from '@/lib/session';

/** `/` resumes onboarding at the step this person is missing, or opens their last project; signed out → sign-in. */
export const Route = createFileRoute('/')({
  beforeLoad: async ({ context }) => {
    const me = await ensureActiveWorkspace(context.queryClient, await requireMe(context.queryClient));
    // No workspace left (the only one removed them or was deleted): the session may still name it as active, and every
    // workspace read would then be refused. Onboarding says which workspace was lost and offers to create one (#4).
    if (me.organizations.length === 0) throw redirect({ to: '/onboarding' });
    throw await resolveOnboarding(context.queryClient);
  },
  pendingComponent: FullPageLoader,
});
