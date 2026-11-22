import { cn } from '@logbird/ui/lib/utils';
import { createFileRoute, Outlet, useRouterState } from '@tanstack/react-router';
import { z } from 'zod';
import { SettingsTabs } from '@/components/settings-tabs';
import { AppShell } from '@/components/shell/app-shell';
import { lastProject } from '@/lib/session';

export const Route = createFileRoute('/_authed/_workspace/workspace')({
  // Workspace activity reads the shared `range` param: a malformed one (`range=0`, decoded as a number) falls back to the default.
  validateSearch: z.object({ range: z.string().optional().catch(undefined) }),
  staticData: { crumb: 'Workspace settings', crumbTo: '/workspace' },
  head: () => ({ meta: [{ title: 'Workspace settings · Logbird' }] }),
  component: WorkspaceSettingsLayout,
});

/**
 * Workspace settings: what belongs to the whole workspace rather than one project. Members (with invites and invite
 * links) and workspace activity live here. "Plan and usage" joins this strip when plans ship.
 */
const TABS = [
  { to: '/workspace/members', label: 'Members' },
  { to: '/workspace/activity', label: 'Workspace activity' },
] as const;

function WorkspaceSettingsLayout() {
  const { workspace } = Route.useRouteContext();
  const pathname = useRouterState({ select: (s) => s.location.pathname.replace(/\/$/, '') });
  // Keep the project nav in the sidebar when coming from a project (as the Account page does).
  const projectId = typeof window === 'undefined' ? undefined : (lastProject() ?? undefined);
  const fills = pathname === '/workspace/activity';
  return (
    <AppShell projectId={projectId}>
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="border-b px-4 pt-5 sm:px-6">
          <h1 className="font-semibold text-xl tracking-tight">Workspace settings</h1>
          <p className="mt-0.5 text-muted-foreground text-sm">{workspace.name} · shared by every project in this workspace</p>
          <SettingsTabs label="Workspace settings sections" pathname={pathname} tabs={TABS} />
        </div>
        <div className={cn('w-full', fills ? 'flex min-h-0 flex-1 flex-col' : 'max-w-4xl p-4 sm:p-6')} data-fills-viewport={fills || undefined}>
          <Outlet />
        </div>
      </div>
    </AppShell>
  );
}
