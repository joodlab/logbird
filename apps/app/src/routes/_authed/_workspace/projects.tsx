import { EntityAvatar } from '@logbird/ui/components/entity-chip';
import { PageHeader } from '@logbird/ui/components/page-header';
import { EmptyState, ErrorState } from '@logbird/ui/components/states';
import { Button } from '@logbird/ui/components/ui/button';
import { Skeleton } from '@logbird/ui/components/ui/skeleton';
import { useQuery } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { FolderPlusIcon, PlusIcon } from 'lucide-react';
import { AdminOnly } from '@/components/admin-gate';
import { AppShell } from '@/components/shell/app-shell';
import { Timestamp } from '@/components/timestamp';
import { projectsQuery } from '@/lib/api/queries';
import { formatNumber, formatRetention } from '@/lib/format';
import { useCan } from '@/lib/permissions';
import { placeholderKeys } from '@/lib/placeholders';

export const Route = createFileRoute('/_authed/_workspace/projects')({
  staticData: { crumb: 'Projects' },
  loader: ({ context }) => context.queryClient.ensureQueryData(projectsQuery()),
  head: () => ({ meta: [{ title: 'Projects · Logbird' }] }),
  component: ProjectsPage,
});

function ProjectsPage() {
  const { workspace } = Route.useRouteContext();
  const projects = useQuery(projectsQuery());
  const canCreate = useCan()('project.create');
  return (
    <AppShell>
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-5 p-4 sm:p-6">
        <PageHeader
          actions={
            canCreate ? (
              <Button nativeButton={false} render={<Link to="/onboarding/project" />} size="sm">
                <PlusIcon />
                New project
              </Button>
            ) : (
              <AdminOnly allowed={false}>
                <Button disabled size="sm">
                  <PlusIcon />
                  New project
                </Button>
              </AdminOnly>
            )
          }
          description={`Every product sending events to ${workspace.name}.`}
          title="Projects"
        />
        {projects.isPending ? (
          <div className="grid gap-3 sm:grid-cols-2">
            {placeholderKeys(4).map((k) => (
              <Skeleton className="h-32 rounded-xl" key={k} />
            ))}
          </div>
        ) : projects.isError ? (
          <ErrorState error={projects.error} onRetry={() => projects.refetch()} />
        ) : projects.data.length === 0 ? (
          <div className="rounded-xl border border-dashed">
            <EmptyState
              description={
                canCreate
                  ? 'Create a project for the first product that should send events.'
                  : 'Ask a workspace owner or admin to create one. Projects appear here as soon as they exist.'
              }
              icon={FolderPlusIcon}
              title="No projects yet"
            >
              {canCreate ? (
                <Button nativeButton={false} render={<Link to="/onboarding/project" />} size="sm">
                  Create project
                </Button>
              ) : null}
            </EmptyState>
          </div>
        ) : (
          <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {projects.data.map((p) => (
              <li className="min-w-0" key={p.id}>
                <Link
                  className="flex h-full flex-col gap-4 rounded-xl border bg-card p-4 shadow-xs outline-none transition-colors hover:border-foreground/20 focus-visible:ring-3 focus-visible:ring-ring/40"
                  params={{ projectId: p.id }}
                  to="/p/$projectId"
                >
                  <div className="flex items-start gap-3">
                    <EntityAvatar id={p.id} name={p.name} size="md" square />
                    <div className="flex min-w-0 flex-col">
                      <span className="truncate font-medium">{p.name}</span>
                      {p.description ? (
                        <span className="line-clamp-2 text-muted-foreground text-sm">{p.description}</span>
                      ) : (
                        <span className="truncate font-mono text-muted-foreground text-xs">{p.slug}</span>
                      )}
                    </div>
                  </div>
                  <dl className="mt-auto grid grid-cols-3 gap-2 text-xs">
                    <div>
                      <dt className="text-muted-foreground">Last 24 h</dt>
                      <dd className="font-medium text-sm tabular-nums">{formatNumber(p.eventsLast24h)}</dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">Last event</dt>
                      <dd className="font-medium text-sm">
                        <Timestamp fallback="never" format="relative" iso={p.lastEventAt} />
                      </dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">Retention</dt>
                      <dd className="font-medium text-sm">{formatRetention(p.retentionDays)}</dd>
                    </div>
                  </dl>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </AppShell>
  );
}
