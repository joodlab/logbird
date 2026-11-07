import { type AuditEvent, WORKSPACE_ACTIVITY_CATEGORIES } from '@logbird/contracts';
import { FilterChip } from '@logbird/ui/components/filter-chip';
import { EmptyState, ErrorState } from '@logbird/ui/components/states';
import { Input } from '@logbird/ui/components/ui/input';
import { useDebouncedValue } from '@tanstack/react-pacer';
import { useInfiniteQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { ActivityIcon, SearchIcon } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { z } from 'zod';
import { EventSheet } from '@/components/explorer/event-sheet';
import { EventsTable, type EventsTableHandle } from '@/components/explorer/events-table';
import { workspaceActivityQuery } from '@/lib/api/queries';
import { formatNumber } from '@/lib/format';
import { includeTerm, removeTerm } from '@/lib/query-language';
import { rangeLabel } from '@/lib/range';
import { useRange } from '@/lib/use-range';

export const Route = createFileRoute('/_authed/_workspace/p/$projectId/settings/activity')({
  head: () => ({ meta: [{ title: 'Workspace activity · Settings · Logbird' }] }),
  validateSearch: z.object({ q: z.string().optional(), ev: z.string().optional() }),
  staticData: { crumb: 'Workspace activity', range: true, defaultRange: '90d' },
  component: WorkspaceActivity,
});

const COLUMNS = ['time', 'outcome', 'action', 'description', 'actor'];

function WorkspaceActivity() {
  const search = Route.useSearch();
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

  const activity = useInfiniteQuery(workspaceActivityQuery(range, q));
  const rows = useMemo(() => activity.data?.pages.flatMap((p) => p.data) ?? [], [activity.data]);
  // The result set the table shows, as of the last non-placeholder results (the query keeps the previous rows while a
  // new search or chip loads): the table starts a new set at the top even when it shares rows with the old one.
  const resultKey = useRef<string | undefined>(undefined);
  if (activity.isSuccess && !activity.isPlaceholderData) resultKey.current = `${range}|${q}|${category ?? ''}`;
  const selectedIndex = search.ev ? rows.findIndex((e) => e.id === search.ev) : -1;
  const select = (e: AuditEvent | null | undefined) => navigate({ search: (prev) => ({ ...prev, ev: e?.id }), replace: true });
  // The table tracks its own keyboard cursor (by event id, following the open event); closing the sheet returns to it.
  const table = useRef<EventsTableHandle>(null);
  // Where focus goes when no row is left to take it (an emptied list, the sheet closing over one).
  const searchInput = useRef<HTMLInputElement>(null);

  return (
    <div className="flex min-h-[28rem] flex-1 flex-col">
      <div className="flex flex-col gap-3 border-b px-4 py-4 sm:px-6">
        <p className="max-w-3xl text-muted-foreground text-sm">
          Logbird records its own management actions — projects, keys, retention, members, views, invite links, sign-ins and sessions — into this
          stream. It is the same event model you send, shown with the same components.{' '}
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
            {activity.data ? `${formatNumber(activity.data.pages[0]?.total ?? 0)} actions · ${rangeLabel(range)}` : null}
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
            loading={activity.isPending}
            onSelect={select}
            ref={table}
            resultKey={resultKey.current}
            rows={rows}
            selectedId={search.ev}
          />
        )}
      </div>
      <EventSheet
        event={selectedIndex >= 0 ? (rows[selectedIndex] ?? null) : null}
        fetchDetail={false}
        // Back to the row the sheet showed last (it may differ from the one opened, after prev/next): never to <body>.
        // With no rows left (a refetch emptied the list meanwhile), to the search field.
        finalFocus={() => table.current?.cursorElement() ?? searchInput.current ?? true}
        onNext={selectedIndex >= 0 && selectedIndex < rows.length - 1 ? () => select(rows[selectedIndex + 1]) : undefined}
        onOpenChange={(open) => {
          if (!open) select(null);
        }}
        onPrev={selectedIndex > 0 ? () => select(rows[selectedIndex - 1]) : undefined}
        open={selectedIndex >= 0}
      />
    </div>
  );
}
