import { createFileRoute } from '@tanstack/react-router';
import { FullPageLoader } from '@/components/route-states';
import { resolveOnboarding } from '@/lib/onboarding';
import { ensureActiveWorkspace, requireMe } from '@/lib/session';

/** `/` resumes onboarding at the step this person is missing, or opens their last project; signed out → sign-in. */
export const Route = createFileRoute('/')({
  beforeLoad: async ({ context }) => {
    await ensureActiveWorkspace(context.queryClient, await requireMe(context.queryClient));
    throw await resolveOnboarding(context.queryClient);
  },
  pendingComponent: FullPageLoader,
});
