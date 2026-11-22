import { type AuditEvent, WORKSPACE_ACTIVITY_CATEGORIES } from '@logbird/contracts';
import { FilterChip } from '@logbird/ui/components/filter-chip';
import { EmptyState, ErrorState } from '@logbird/ui/components/states';
import { Button } from '@logbird/ui/components/ui/button';
import { Input } from '@logbird/ui/components/ui/input';
import { useDebouncedValue } from '@tanstack/react-pacer';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { ActivityIcon, FolderPlusIcon, SearchIcon } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { z } from 'zod';
import { EventSheet } from '@/components/explorer/event-sheet';
import { EventsTable, type EventsTableHandle } from '@/components/explorer/events-table';
import { TimeZoneInline } from '@/components/time-zone-control';
import { api } from '@/lib/api/client';
import { awaiting, current } from '@/lib/api/current';
import { projectsQuery, workspaceActivityQuery } from '@/lib/api/queries';
import { useCan } from '@/lib/permissions';
import { formatExactTerm, includeTerm, removeTerm } from '@/lib/query-language';
import { rangeLabel, resolveRange } from '@/lib/range';
import { formatSearchTotal, searchTotal } from '@/lib/search-total';
import { useConsoleZone } from '@/lib/time-zone';
import { useRange } from '@/lib/use-range';

export const Route = createFileRoute('/_authed/_workspace/workspace/activity')({
  head: () => ({ meta: [{ title: 'Workspace activity · Workspace settings · Logbird' }] }),
  validateSearch: z.object({ q: z.string().optional(), ev: z.string().optional() }),
  staticData: { crumb: 'Workspace activity', range: true, defaultRange: '90d' },
  component: WorkspaceActivity,
});

const COLUMNS = ['time', 'outcome', 'action', 'description', 'actor'];

function WorkspaceActivity() {
  useConsoleZone(); // Range labels and times read the console zone: re-render when the reader switches it.
  const search = Route.useSearch();
  const { workspace } = Route.useRouteContext();
  const navigate = Route.useNavigate();
  // Management actions are rare: this page defaults to a 90-day window (staticData.defaultRange).
  const { range } = useRange();
  const q = search.q ?? '';
  const [draft, setDraft] = useState(q.replace(/category:\S+/g, '').trim());
  const [debounced] = useDebouncedValue(draft, { wait: 250 });
  const category = /category:(\S+)/.exec(q)?.[1];

  // biome-ignore lint/correctness/useExhaustiveDependencies: sync the debounced free text into the URL
  useEffect(() => {
    const next = [category ? `category:${category}` : '', debounced.trim()].filter(Boolean).join(' ');
    if (next !== q) navigate({ search: (prev) => ({ ...prev, q: next || undefined }), replace: true });
  }, [debounced]);

  const activity = useInfiniteQuery(workspaceActivityQuery(workspace.id, range, q));
  // Another range's or search's actions never show (or count) under this one's label.
  const pages = current(activity)?.pages;
  const activityTotal = searchTotal(pages, pages?.reduce((n, p) => n + p.data.length, 0) ?? 0, activity.hasNextPage);
  const rows = useMemo(() => pages?.flatMap((p) => p.data) ?? [], [pages]);
  // The result set the table shows, as of the last non-placeholder results (the query keeps the previous rows while a
  // new search or chip loads): the table starts a new set at the top even when it shares rows with the old one.
  const resultKey = useRef<string | undefined>(undefined);
  if (activity.isSuccess && !activity.isPlaceholderData) resultKey.current = `${range}|${q}|${category ?? ''}`;
  // A workspace without projects (reachable here before the first one exists) gets a next step.
  const projectList = useQuery(projectsQuery());
  const noProjects = projectList.data?.length === 0;
  const canCreateProject = useCan()('project.create');
  const selectedIndex = search.ev ? rows.findIndex((e) => e.id === search.ev) : -1;
  // A bookmarked or shared event beyond the loaded pages (page two, or any later one) is looked up by its id in the same
  // workspace stream and range, so the link opens it without loading every page before it.
  const loneEvent = useQuery({
    // Keyed by workspace too: another tab can switch the session's workspace, and a cached event never crosses over.
    queryKey: ['workspace-activity-event', workspace.id, range, search.ev],
    queryFn: ({ signal }) => {
      const r = resolveRange(range);
      return api.workspaceActivity({ from: r.from, to: r.to, q: formatExactTerm('id', search.ev ?? ''), limit: 1 }, signal);
    },
    enabled: Boolean(search.ev) && selectedIndex < 0 && Boolean(pages),
  });
  const lone = selectedIndex < 0 ? current(loneEvent)?.data.find((e) => e.id === search.ev) : undefined;
  const select = (e: AuditEvent | null | undefined) => navigate({ search: (prev) => ({ ...prev, ev: e?.id }), replace: true });
  // The table tracks its own keyboard cursor (by event id, following the open event); closing the sheet returns to it.
  const table = useRef<EventsTableHandle>(null);
  // Where focus goes when no row is left to take it (an emptied list, the sheet closing over one).
  const searchInput = useRef<HTMLInputElement>(null);

  return (
    <div className="flex min-h-[28rem] flex-1 flex-col">
      <div className="flex flex-col gap-3 border-b px-4 py-4 sm:px-6">
        {noProjects ? (
          // A new workspace (managed before its first project exists): say what to do next.
          <div
            className="flex flex-col gap-3 rounded-lg border border-dashed bg-muted/30 p-4 sm:flex-row sm:items-center sm:justify-between"
            data-testid="no-projects"
          >
            <div className="flex flex-col gap-0.5">
              <p className="font-medium text-sm">This workspace has no projects yet</p>
              <p className="text-muted-foreground text-sm">
                {canCreateProject
                  ? 'Create your first project to get an ingest key and start sending events. Workspace actions are recorded here either way.'
                  : 'Ask a workspace owner or admin to create the first project. Workspace actions are recorded here either way.'}
              </p>
            </div>
            {canCreateProject ? (
              <Button nativeButton={false} render={<Link search={{ new: true }} to="/projects" />} size="sm">
                <FolderPlusIcon />
                Create your first project
              </Button>
            ) : null}
          </div>
        ) : null}
        <p className="max-w-3xl text-muted-foreground text-sm">
          Logbird records its own management actions — projects, keys, retention, members, views, invite links, sign-ins, sessions and exports — into
          this stream. It is the same event model you send, shown with the same components.{' '}
          <a
            className="underline underline-offset-4"
            href="https://github.com/joodlab/logbird/blob/master/docs/workspace-audit.md"
            target="_blank"
            rel="noreferrer"
          >
            Activity action catalogue
          </a>
        </p>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <div className="relative w-full sm:max-w-xs">
            <SearchIcon className="-translate-y-1/2 pointer-events-none absolute start-3 top-1/2 size-4 text-muted-foreground" />
            <Input
              aria-label="Search workspace activity"
              className="ps-9"
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Search activity…"
              ref={searchInput}
              size="sm"
              value={draft}
            />
          </div>
          <fieldset className="flex flex-wrap gap-1.5">
            <legend className="sr-only">Filter by area</legend>
            {WORKSPACE_ACTIVITY_CATEGORIES.map(([value, label]) => (
              <FilterChip
                active={category === value}
                key={value}
                onClick={() =>
                  navigate({
                    search: (prev) => ({
                      ...prev,
                      q: (category === value ? removeTerm(q, 'category') : includeTerm(q, 'category', value)) || undefined,
                    }),
                    replace: true,
                  })
                }
              >
                {label}
              </FilterChip>
            ))}
          </fieldset>
          <span className="text-muted-foreground text-xs sm:ms-auto">
            {pages ? `${formatSearchTotal(activityTotal)} ${activityTotal.count === 1 ? 'action' : 'actions'} · ${rangeLabel(range)}` : null}
            {/* Below md the table has no column header: name the zone here (and switch it). */}
            <TimeZoneInline className="md:hidden" />
          </span>
        </div>
      </div>
      <div className="flex min-h-[420px] flex-1 flex-col">
        {activity.isError ? (
          <ErrorState error={activity.error} onRetry={() => activity.refetch()} title="Could not load workspace activity" />
        ) : (
          <EventsTable
            columns={COLUMNS}
            empty={
              <EmptyState
                description="Management actions in this workspace show up here as they happen."
                icon={ActivityIcon}
                title="No activity in this range"
              />
            }
            fetchingMore={activity.isFetchingNextPage}
            focusFallback={() => searchInput.current}
            hasMore={activity.hasNextPage}
            loadMore={() => activity.fetchNextPage()}
            loading={awaiting(activity)}
            onSelect={select}
            ref={table}
            resultKey={resultKey.current}
            rows={rows}
            selectedId={search.ev}
          />
        )}
      </div>
      <EventSheet
        event={selectedIndex >= 0 ? (rows[selectedIndex] ?? null) : (lone ?? null)}
        fetchDetail={false}
        // Back to the row the sheet showed last (it may differ from the one opened, after prev/next): never to <body>.
        // With no rows left (a refetch emptied the list meanwhile), to the search field.
        finalFocus={() => table.current?.cursorElement() ?? searchInput.current ?? true}
        onNext={selectedIndex >= 0 && selectedIndex < rows.length - 1 ? () => select(rows[selectedIndex + 1]) : undefined}
        onOpenChange={(open) => {
          if (!open) select(null);
        }}
        onPrev={selectedIndex > 0 ? () => select(rows[selectedIndex - 1]) : undefined}
        open={selectedIndex >= 0 || Boolean(lone)}
      />
    </div>
  );
}
