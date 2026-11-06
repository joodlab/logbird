import type { SavedView } from '@logbird/contracts';
import { CopyButton } from '@logbird/ui/components/copy-button';
import { EntityChip } from '@logbird/ui/components/entity-chip';
import { PageHeader } from '@logbird/ui/components/page-header';
import { EmptyState, ErrorState } from '@logbird/ui/components/states';
import { Button } from '@logbird/ui/components/ui/button';
import { useConfirm } from '@logbird/ui/components/ui/confirm';
import { Skeleton } from '@logbird/ui/components/ui/skeleton';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { BookmarkIcon, Rows3Icon, Trash2Icon } from 'lucide-react';
import { toast } from 'sonner';
import { SqlBadge } from '@/components/explorer/explorer-toolbar';
import { HighlightedText } from '@/components/query-input/highlighted';
import { Timestamp } from '@/components/timestamp';
import { api } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import { keys, viewsQuery } from '@/lib/api/queries';
import { creatorLabel } from '@/lib/events';
import { placeholderKeys } from '@/lib/placeholders';
import { rangeLabel } from '@/lib/range';

export const Route = createFileRoute('/_authed/_workspace/p/$projectId/views')({
  staticData: { crumb: 'Saved views' },
  loader: ({ context, params }) => context.queryClient.prefetchQuery(viewsQuery(params.projectId)),
  head: () => ({ meta: [{ title: 'Saved views · Logbird' }] }),
  component: ViewsPage,
});

function viewSearch(view: SavedView) {
  return {
    q: view.state.q || undefined,
    lang: view.state.lang === 'sql' ? ('sql' as const) : undefined,
    range: view.state.range,
    cols: view.state.columns?.join(',') || undefined,
    view: view.id,
  };
}

function ViewsPage() {
  const { projectId } = Route.useParams();
  const views = useQuery(viewsQuery(projectId));
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const remove = useMutation({
    mutationFn: (id: string) => api.views.remove(projectId, id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: [...keys.project(projectId), 'views'] }),
    onError: (error) => toast.error('Could not delete the view', { description: errorMessage(error) }),
  });

  return (
    <div className="flex flex-col gap-5 p-4 sm:p-6">
      <PageHeader
        actions={
          <Button nativeButton={false} render={<Link params={{ projectId }} to="/p/$projectId/events" />} size="sm" variant="outline">
            <Rows3Icon />
            New from explorer
          </Button>
        }
        description="Saved explorer states — query, time range and columns. Share one by copying its link."
        title="Saved views"
      />
      {views.isPending ? (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {placeholderKeys(6).map((k) => (
            <Skeleton className="h-36 rounded-xl" key={k} />
          ))}
        </div>
      ) : views.isError ? (
        <ErrorState error={views.error} onRetry={() => views.refetch()} />
      ) : views.data.length === 0 ? (
        <div className="rounded-xl border border-dashed">
          <EmptyState
            description="Build a search in the explorer, then use “Save view”. Views show up here and in the sidebar for the whole workspace."
            icon={BookmarkIcon}
            title="No saved views yet"
          >
            <Button nativeButton={false} render={<Link params={{ projectId }} to="/p/$projectId/events" />} size="sm">
              Open explorer
            </Button>
          </EmptyState>
        </div>
      ) : (
        <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {views.data.map((view) => {
            const href =
              typeof window === 'undefined'
                ? ''
                : `${window.location.origin}/p/${projectId}/events?${new URLSearchParams(Object.entries(viewSearch(view)).filter(([, v]) => v) as [string, string][]).toString()}`;
            return (
              <li
                className="group flex flex-col gap-3 rounded-xl border bg-card p-4 shadow-xs transition-colors hover:border-foreground/20"
                key={view.id}
              >
                <div className="flex items-start justify-between gap-2">
                  <Link
                    className="flex min-w-0 flex-col gap-0.5 outline-none"
                    params={{ projectId }}
                    search={viewSearch(view)}
                    to="/p/$projectId/events"
                  >
                    <span className="flex items-center gap-2 font-medium">
                      <BookmarkIcon className="size-4 shrink-0 text-brand" />
                      <span className="truncate group-hover:underline group-hover:underline-offset-2">{view.name}</span>
                      {view.state.lang === 'sql' ? <SqlBadge /> : null}
                    </span>
                    {view.description ? <span className="line-clamp-2 text-muted-foreground text-sm">{view.description}</span> : null}
                  </Link>
                  <div className="flex shrink-0 items-center">
                    <CopyButton label="Copy share link" value={href} />
                    <Button
                      aria-label={`Delete ${view.name}`}
                      className="text-muted-foreground hover:text-destructive"
                      onClick={async () => {
                        const ok = await confirm({
                          title: `Delete “${view.name}”?`,
                          description: 'The view disappears for everyone in the workspace. Events are not affected.',
                          confirmLabel: 'Delete view',
                          destructive: true,
                        });
                        if (ok) remove.mutate(view.id);
                      }}
                      size="icon-xs"
                      variant="ghost"
                    >
                      <Trash2Icon />
                    </Button>
                  </div>
                </div>
                <pre className="overflow-hidden rounded-md bg-muted/50 px-2.5 py-1.5 font-mono text-[12px]">
                  <code className="block truncate">
                    {view.state.q ? (
                      <HighlightedText lang={view.state.lang ?? 'query'} value={view.state.q} />
                    ) : (
                      <span className="text-muted-foreground">All events</span>
                    )}
                  </code>
                </pre>
                <div className="mt-auto flex items-center justify-between gap-2 text-muted-foreground text-xs">
                  <span>{rangeLabel(view.state.range ?? '24h')}</span>
                  <span className="flex min-w-0 items-center gap-1.5">
                    {view.createdBy && creatorLabel(view.createdBy) ? (
                      <EntityChip className="max-w-32" id={view.createdBy.id} name={creatorLabel(view.createdBy)} />
                    ) : null}
                    <span className="shrink-0">
                      · <Timestamp format="relative" iso={view.createdAt} />
                    </span>
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
