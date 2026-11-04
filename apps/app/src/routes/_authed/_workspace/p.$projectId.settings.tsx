import { createFileRoute, Link, Outlet, useRouterState } from '@tanstack/react-router';
import { cn } from '@trailmark/ui/lib/utils';

export const Route = createFileRoute('/_authed/_workspace/p/$projectId/settings')({
  staticData: { crumb: 'Settings' },
  head: () => ({ meta: [{ title: 'Settings · Trailmark' }] }),
  component: SettingsLayout,
});

const TABS = [
  { to: '/p/$projectId/settings', label: 'General', exact: true },
  { to: '/p/$projectId/settings/retention', label: 'Retention' },
  { to: '/p/$projectId/settings/keys', label: 'API keys' },
  { to: '/p/$projectId/settings/members', label: 'Members' },
  { to: '/p/$projectId/settings/activity', label: 'Workspace activity' },
  { to: '/p/$projectId/settings/danger', label: 'Danger zone' },
] as const;

function SettingsLayout() {
  const { projectId } = Route.useParams();
  const pathname = useRouterState({ select: (s) => s.location.pathname.replace(/\/$/, '') });
  const isActivity = pathname.endsWith('/settings/activity');
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b px-4 pt-5 sm:px-6">
        <h1 className="font-semibold text-xl tracking-tight">Settings</h1>
        <nav aria-label="Settings sections" className="-mb-px mt-3 flex gap-1 overflow-x-auto">
          {TABS.map((tab) => {
            const href = tab.to.replace('$projectId', projectId);
            const active = 'exact' in tab ? pathname === href : pathname === href;
            return (
              <Link
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'relative shrink-0 whitespace-nowrap px-3 pt-1 pb-2.5 text-sm outline-none transition-colors hover:text-foreground focus-visible:text-foreground',
                  active
                    ? 'font-medium text-foreground after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full after:bg-brand'
                    : 'text-muted-foreground',
                  tab.label === 'Danger zone' && !active && 'hover:text-destructive',
                )}
                key={tab.to}
                params={{ projectId }}
                to={tab.to}
              >
                {tab.label}
              </Link>
            );
          })}
        </nav>
      </div>
      <div className={cn('w-full', isActivity ? 'flex min-h-0 flex-1 flex-col' : 'max-w-4xl p-4 sm:p-6')}>
        <Outlet />
      </div>
    </div>
  );
}
