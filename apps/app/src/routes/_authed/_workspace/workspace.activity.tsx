import { type AuditEvent, WORKSPACE_ACTIVITY_CATEGORIES } from '@logbird/contracts';
import { FilterChip } from '@logbird/ui/components/filter-chip';
import { EmptyState, ErrorState } from '@logbird/ui/components/states';
import { Button } from '@logbird/ui/components/ui/button';
import { Input } from '@logbird/ui/components/ui/input';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { createFileRoute, Link, useRouter, useRouterState } from '@tanstack/react-router';
import { ActivityIcon, FolderPlusIcon, SearchIcon } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { z } from 'zod';
import { EventSheet } from '@/components/explorer/event-sheet';
import { EventsTable, type EventsTableHandle } from '@/components/explorer/events-table';
import { TimeZoneInline } from '@/components/time-zone-control';
import { activityChip, activityFreeText, activityQuery, toggleActivityChip } from '@/lib/activity-search';
import { api } from '@/lib/api/client';
import { awaiting, current } from '@/lib/api/current';
import { workspaceActivityQuery, workspaceProjectsQuery } from '@/lib/api/queries';
import { useCan } from '@/lib/permissions';
import { formatExactTerm } from '@/lib/query-language';
import { rangeLabel, resolveRange } from '@/lib/range';
import { createSearchCommitter } from '@/lib/search-committer';
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
  // The area chip stands for one positive top-level `category:` term; the box holds everything else as written, so a
  // bookmark such as `-category:auth` or `category:auth OR category:member` opens exactly as saved (lib/activity-search.ts).
  const category = activityChip(q);
  const [draft, setDraft] = useState(() => activityFreeText(q));
  // The location and its query from one router snapshot: the route's validated search can lag the location by a render
  // during a transition, and the box must never compare a fresh location with a stale query.
  const href = useRouterState({ select: (s) => s.location.href });
  const locationQ = useRouterState({ select: (s) => ((s.location.search as { q?: unknown }).q as string | undefined) ?? '' });
  const router = useRouter();
  const qRef = useRef(locationQ);
  qRef.current = locationQ;
  const draftRef = useRef(draft);
  draftRef.current = draft;
  // The query this page last wrote, and the box text it came from: the URL change that follows is ours, not a navigation.
  const ownWrite = useRef<{ q: string; text: string } | null>(null);
  const write = (next: string, text: string) => {
    ownWrite.current = { q: next, text };
    navigate({ search: (prev) => ({ ...prev, q: next || undefined }), replace: true });
  };
  // Typed text reaches the URL after a 250 ms pause, only if the page is still where the edit started (lib/search-committer.ts).
  const [committer] = useState(() =>
    createSearchCommitter({
      wait: 250,
      // The history entry (its index): replace-writes keep it, Back/Forward and pushes change it.
      entry: () => `${router.history.location.state.__TSR_index ?? 0}`,
      commit: (text) => {
        const next = activityQuery(activityChip(qRef.current), text);
        if (next !== qRef.current) write(next, text);
      },
    }),
  );
  useEffect(() => () => committer.cancel(), [committer]);

  // Every location change. Our own write settles the box (a typed `category:auth` becomes the chip, unless the reader kept
  // typing). A navigation (another history entry: Back/Forward, a range picked in the header, a link) or a query changed
  // from outside cancels a pending edit and shows the new query, exactly as the committer drops it. A replace that only
  // opens or closes an event (`ev`) is not a navigation: the edit carries on, whichever of the two happens first.
  const entryRef = useRef(`${router.history.location.state.__TSR_index ?? 0}`);
  const syncedQ = useRef(locationQ);
  // biome-ignore lint/correctness/useExhaustiveDependencies: react to the location only
  useEffect(() => {
    const entry = `${router.history.location.state.__TSR_index ?? 0}`;
    const moved = entry !== entryRef.current;
    entryRef.current = entry;
    const own = ownWrite.current;
    ownWrite.current = null;
    if (own && own.q === locationQ && !moved) {
      syncedQ.current = locationQ;
      if (committer.pending === undefined && draftRef.current === own.text) setDraft(activityFreeText(locationQ));
      return;
    }
    if (!moved && locationQ === syncedQ.current) return;
    syncedQ.current = locationQ;
    committer.cancel();
    setDraft(activityFreeText(locationQ));
  }, [href]);

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
  const projectList = useQuery(workspaceProjectsQuery(workspace.id));
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
              onChange={(e) => {
                setDraft(e.target.value);
                committer.edit(e.target.value);
              }}
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
                onClick={() => {
                  // Text still being typed is part of the query the chip changes: fold it in, never drop it.
                  const text = committer.takePending() ?? draftRef.current;
                  const next = toggleActivityChip(activityQuery(activityChip(qRef.current), text), value);
                  setDraft(activityFreeText(next));
                  write(next, activityFreeText(next));
                }}
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
