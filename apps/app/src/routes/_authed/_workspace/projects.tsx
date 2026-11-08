import { EntityAvatar } from '@logbird/ui/components/entity-chip';
import { PageHeader } from '@logbird/ui/components/page-header';
import { EmptyState, ErrorState } from '@logbird/ui/components/states';
import { Button } from '@logbird/ui/components/ui/button';
import { Skeleton } from '@logbird/ui/components/ui/skeleton';
import { useQuery } from '@tanstack/react-query';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { FolderPlusIcon, PlusIcon } from 'lucide-react';
import { useRef, useState } from 'react';
import { z } from 'zod';
import { AdminOnly } from '@/components/admin-gate';
import { NewProjectDialog } from '@/components/projects/new-project-dialog';
import { AppShell } from '@/components/shell/app-shell';
import { Timestamp } from '@/components/timestamp';
import { projectsQuery } from '@/lib/api/queries';
import { formatNumber, formatRetention } from '@/lib/format';
import { useCan } from '@/lib/permissions';
import { placeholderKeys } from '@/lib/placeholders';
import { sortProjectsByActivity } from '@/lib/projects';

export const Route = createFileRoute('/_authed/_workspace/projects')({
  /** `new`: open the New project dialog (old links to the onboarding wizard land here once a project exists). */
  validateSearch: z.object({ new: z.boolean().optional().catch(undefined) }),
  staticData: { crumb: 'Projects' },
  loader: ({ context }) => context.queryClient.ensureQueryData(projectsQuery()),
  head: () => ({ meta: [{ title: 'Projects · Logbird' }] }),
  component: ProjectsPage,
});

function ProjectsPage() {
  const { workspace } = Route.useRouteContext();
  const projects = useQuery(projectsQuery());
  const canCreate = useCan()('project.create');
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const [newOpen, setNewOpenState] = useState(Boolean(search.new));
  const setNewOpen = (open: boolean) => {
    setNewOpenState(open);
    if (!open && search.new) navigate({ search: {}, replace: true });
  };
  const newButton = useRef<HTMLButtonElement>(null);
  return (
    <AppShell>
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-5 p-4 sm:p-6">
        <PageHeader
          actions={
            canCreate ? (
              <Button onClick={() => setNewOpen(true)} ref={newButton} size="sm">
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
                <Button onClick={() => setNewOpen(true)} size="sm">
                  Create project
                </Button>
              ) : null}
            </EmptyState>
          </div>
        ) : (
          <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {sortProjectsByActivity(projects.data).map((p) => (
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
      {canCreate ? <NewProjectDialog finalFocus={newButton} onOpenChange={setNewOpen} open={newOpen} workspaceName={workspace.name} /> : null}
    </AppShell>
  );
}
