import { createFileRoute, Outlet, useRouterState } from '@tanstack/react-router';
import { SettingsTabs } from '@/components/settings-tabs';

export const Route = createFileRoute('/_authed/_workspace/p/$projectId/settings')({
  staticData: { crumb: 'Settings' },
  head: () => ({ meta: [{ title: 'Settings · Logbird' }] }),
  component: SettingsLayout,
});

/**
 * Project settings: what belongs to this project. Members, invite links and workspace activity belong to the workspace
 * (Workspace settings, /workspace). Webhooks and Alerts join here when they ship.
 */
const TABS = [
  { to: '/p/$projectId/settings', label: 'General' },
  { to: '/p/$projectId/settings/retention', label: 'Retention' },
  { to: '/p/$projectId/settings/keys', label: 'API keys' },
  { to: '/p/$projectId/settings/danger', label: 'Danger zone', danger: true },
] as const;

function SettingsLayout() {
  const { projectId } = Route.useParams();
  const pathname = useRouterState({ select: (s) => s.location.pathname.replace(/\/$/, '') });
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b px-4 pt-5 sm:px-6">
        <h1 className="font-semibold text-xl tracking-tight">Settings</h1>
        <SettingsTabs label="Settings sections" pathname={pathname} tabs={TABS.map((t) => ({ ...t, params: { projectId } }))} />
      </div>
      <div className="w-full max-w-4xl p-4 sm:p-6">
        <Outlet />
      </div>
    </div>
  );
}
