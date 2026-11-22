import { createFileRoute, Outlet } from '@tanstack/react-router';
import { Fragment } from 'react';
import { FullPageLoader } from '@/components/route-states';
import { requireMe } from '@/lib/session';
import { useZonePreference } from '@/lib/time-zone';

/** Everything below requires a session; unauthenticated visitors go to /login?redirect=… */
export const Route = createFileRoute('/_authed')({
  beforeLoad: async ({ context, location }) => {
    const me = await requireMe(context.queryClient, location.href);
    return { me };
  },
  pendingComponent: FullPageLoader,
  component: ZoneScope,
});

/** Every formatter reads the console zone when it runs: switching Local/UTC re-renders the signed-in app once. */
function ZoneScope() {
  const preference = useZonePreference();
  return (
    <Fragment key={preference}>
      <Outlet />
    </Fragment>
  );
}
