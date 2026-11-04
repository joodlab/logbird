import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import type { AuditEvent } from '@trailmark/contracts';
import { EmptyState, ErrorState } from '@trailmark/ui/components/states';
import { Button } from '@trailmark/ui/components/ui/button';
import { Sheet, SheetContent, SheetTitle } from '@trailmark/ui/components/ui/sheet';
import { Switch } from '@trailmark/ui/components/ui/switch';
import { Tooltip, TooltipContent, TooltipTrigger } from '@trailmark/ui/components/ui/tooltip';
import { cn } from '@trailmark/ui/lib/utils';
import { ArrowUpIcon, ChevronDownIcon, FilterIcon, PanelLeftCloseIcon, PanelLeftOpenIcon, SearchXIcon } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EventHistogram } from '@/components/charts/event-histogram';
import { api } from '@/lib/api/client';
import { eventQuery, eventsInfiniteQuery, histogramQuery } from '@/lib/api/queries';
import { formatNumber } from '@/lib/format';
import { absoluteRange, isValidRange, pickInterval, rangeLabel } from '@/lib/range';
import { EventSheet } from './event-sheet';
import { EventsTable } from './events-table';
import { ColumnPicker, ExportMenu, SaveViewButton } from './explorer-toolbar';
import { FacetSidebar } from './facet-sidebar';
import { QueryBar, type QueryBarHandle } from './query-bar';

export interface ExplorerState {
  q: string;
  range: string;
  columns: string[];
  ev?: string;
  live: boolean;
}

interface ExplorerProps {
  projectId: string;
  state: ExplorerState;
  onChange: (patch: Partial<ExplorerState>) => void;
  /** Always-applied filter (entity pages). Shown as a locked prefix. */
  baseQuery?: string;
  baseLabel?: string;
  /** Compact layout for embedding in profile pages. */
  embedded?: boolean;
  className?: string;
}

const FACETS_KEY = 'trailmark.explorer.facets';

function newestArrival(events: AuditEvent[]): string | undefined {
  return events.reduce<string | undefined>((max, e) => (!max || e.receivedAt > max ? e.receivedAt : max), undefined);
}

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return Boolean(el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable || el.closest('[role=dialog]')));
}

export function Explorer({ projectId, state, onChange, baseQuery, baseLabel, embedded = false, className }: ExplorerProps) {
  const { q, range, columns, ev, live } = state;
  const effectiveQ = [baseQuery, q].filter(Boolean).join(' ');
  const queryBar = useRef<QueryBarHandle>(null);
  const [facetsOpen, setFacetsOpen] = useState(() => {
    if (embedded || typeof window === 'undefined') return false;
    try {
      return window.localStorage.getItem(FACETS_KEY) !== '0';
    } catch {
      return true;
    }
  });
  const [mobileFacets, setMobileFacets] = useState(false);
  const [showChart, setShowChart] = useState(true);
  const [cursor, setCursor] = useState(-1);

  const events = useInfiniteQuery(eventsInfiniteQuery(projectId, range, effectiveQ));
  // Round bucket sizes (30 min for 24 h, 3 h for 7 d) so bars line up with the axis ticks.
  const histogram = useQuery(histogramQuery(projectId, range, effectiveQ, pickInterval(range)));

  /* ---------------- live tail ---------------- */
  const relative = isValidRange(range) && !range.includes('..');
  const liveActive = live && relative;
  const [liveRows, setLiveRows] = useState<AuditEvent[]>([]);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const sinceRef = useRef<string | null>(null);
  const liveRowsRef = useRef<AuditEvent[]>([]);
  liveRowsRef.current = liveRows;
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset the tail whenever the result set identity changes
  useEffect(() => {
    setLiveRows([]);
    sinceRef.current = null;
  }, [effectiveQ, range, live]);

  // The tail follows *arrival* (`receivedAt`), so late or back-dated events still stream in.
  const firstPage = events.data?.pages[0]?.data;
  useEffect(() => {
    if (!sinceRef.current && firstPage) sinceRef.current = newestArrival(firstPage) ?? new Date().toISOString();
  }, [firstPage]);

  useQuery({
    queryKey: ['projects', projectId, 'live-tail', effectiveQ, range],
    enabled: liveActive && Boolean(firstPage),
    refetchInterval: 2500,
    refetchIntervalInBackground: false,
    gcTime: 0,
    queryFn: async ({ signal }) => {
      const since = sinceRef.current ?? new Date().toISOString();
      // `since` is inclusive, so the newest known arrivals come back too: dedupe by id.
      const data = await api.events.live(projectId, { since, q: effectiveQ || undefined, limit: 100 }, signal);
      const known = new Set([...(firstPage ?? []), ...liveRowsRef.current].map((e) => e.id));
      const incoming = data.filter((e) => !known.has(e.id));
      sinceRef.current = newestArrival(data) ?? since;
      if (incoming.length) {
        setLiveRows((prev) => [...incoming, ...prev].slice(0, 2000));
        setFresh(new Set(incoming.map((e) => e.id)));
      }
      return incoming.length;
    },
  });

  const rows = useMemo(() => {
    const paged = events.data?.pages.flatMap((p) => p.data) ?? [];
    if (!liveRows.length) return paged;
    const seen = new Set(liveRows.map((e) => e.id));
    return [...liveRows, ...paged.filter((e) => !seen.has(e.id))];
  }, [events.data, liveRows]);
  const total = (events.data?.pages[0]?.total ?? 0) + liveRows.length;

  /* ---------------- selection ---------------- */
  const selectedIndex = ev ? rows.findIndex((e) => e.id === ev) : -1;
  const selectedFromRows = selectedIndex >= 0 ? rows[selectedIndex] : undefined;
  const deepLinked = useQuery({ ...eventQuery(projectId, ev ?? ''), enabled: Boolean(ev) && !selectedFromRows && !events.isPending });
  const selected = selectedFromRows ?? deepLinked.data?.event ?? null;

  const select = useCallback((e: AuditEvent | null) => onChange({ ev: e?.id }), [onChange]);
  const move = useCallback(
    (delta: number) => {
      if (rows.length === 0) return;
      const from = ev ? selectedIndex : cursor;
      const next = Math.min(rows.length - 1, Math.max(0, (from < 0 ? -1 : from) + delta));
      setCursor(next);
      if (ev) select(rows[next] ?? null);
    },
    [rows, ev, selectedIndex, cursor, select],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === '/' && !isTyping(event.target)) {
        event.preventDefault();
        queryBar.current?.focus();
        return;
      }
      if (isTyping(event.target) && !(ev && (event.key === 'j' || event.key === 'k'))) return;
      if (event.key === 'j') {
        event.preventDefault();
        move(1);
      } else if (event.key === 'k') {
        event.preventDefault();
        move(-1);
      } else if ((event.key === 'Enter' || event.key === 'o') && cursor >= 0 && !ev) {
        event.preventDefault();
        select(rows[cursor] ?? null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [move, cursor, ev, rows, select]);

  const addFilter = (term: string) => onChange({ q: `${q} ${term}`.trim(), ev: undefined });

  const empty = events.isError ? (
    <ErrorState error={events.error} onRetry={() => events.refetch()} title="Search failed" />
  ) : (
    <EmptyState
      description={
        q ? (
          <>
            Nothing in <span className="font-medium text-foreground">{rangeLabel(range).toLowerCase()}</span> matches{' '}
            <span className="font-mono text-foreground">{q}</span>. Try a wider range or remove a filter.
          </>
        ) : (
          `No events in ${rangeLabel(range).toLowerCase()}. Widen the range, or send events with your ingest key.`
        )
      }
      icon={SearchXIcon}
      title={q ? 'No matching events' : 'No events in this range'}
    >
      {q ? (
        <Button onClick={() => onChange({ q: '' })} size="sm" variant="outline">
          Clear query
        </Button>
      ) : null}
      {range !== '30d' ? (
        <Button onClick={() => onChange({ range: '30d' })} size="sm" variant="outline">
          Search last 30 days
        </Button>
      ) : null}
    </EmptyState>
  );

  const facetsPanel = <FacetSidebar onChange={(next) => onChange({ q: next, ev: undefined })} projectId={projectId} q={q} range={range} />;

  return (
    <div className={cn('flex min-h-0 flex-1 flex-col', className)}>
      <div className="flex flex-col gap-2 border-b px-3 py-2.5 sm:px-4">
        <div className="flex items-center gap-2">
          {embedded ? null : (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    aria-label={facetsOpen ? 'Hide filters' : 'Show filters'}
                    className="hidden lg:inline-flex"
                    onClick={() => {
                      setFacetsOpen((o) => {
                        try {
                          window.localStorage.setItem(FACETS_KEY, o ? '0' : '1');
                        } catch {
                          // Preference only.
                        }
                        return !o;
                      });
                    }}
                    size="icon-sm"
                    variant="ghost"
                  />
                }
              >
                {facetsOpen ? <PanelLeftCloseIcon /> : <PanelLeftOpenIcon />}
              </TooltipTrigger>
              <TooltipContent>{facetsOpen ? 'Hide filters' : 'Show filters'}</TooltipContent>
            </Tooltip>
          )}
          <Button aria-label="Filters" className="lg:hidden" onClick={() => setMobileFacets(true)} size="icon-sm" variant="outline">
            <FilterIcon />
          </Button>
          {baseQuery ? (
            <span
              className="hidden h-9 max-w-56 shrink-0 items-center truncate rounded-lg border border-dashed bg-muted/40 px-2.5 font-mono text-[12px] text-muted-foreground md:flex"
              title={`Always applied: ${baseQuery}`}
            >
              {baseLabel ?? baseQuery}
            </span>
          ) : null}
          <QueryBar
            onSubmit={(next) => onChange({ q: next, ev: undefined })}
            placeholder={embedded ? 'Filter this timeline… e.g. outcome:failure' : 'Search… e.g. action:hotel.* outcome:failure actor:usr_42'}
            projectId={projectId}
            range={range}
            ref={queryBar}
            value={q}
          />
          <Tooltip>
            <TooltipTrigger
              render={
                <div
                  className={cn(
                    'flex h-8 shrink-0 items-center gap-2 rounded-md border px-2.5 text-sm shadow-xs',
                    liveActive && 'border-outcome-success/40 bg-outcome-success/5',
                    !relative && 'opacity-60',
                  )}
                />
              }
            >
              <Switch
                checked={liveActive}
                disabled={!relative}
                id={embedded ? 'live-tail-embedded' : 'live-tail'}
                onCheckedChange={(checked) => onChange({ live: checked || undefined })}
                size="sm"
              />
              <label
                className={cn('flex items-center gap-1.5', relative ? 'cursor-pointer' : 'cursor-not-allowed')}
                htmlFor={embedded ? 'live-tail-embedded' : 'live-tail'}
              >
                {liveActive ? <span className="tm-pulse-dot size-1.5 rounded-full bg-outcome-success text-outcome-success" /> : null}
                Live
              </label>
            </TooltipTrigger>
            <TooltipContent>
              {relative ? 'Stream new events as they arrive' : 'Live tail needs a relative range (e.g. last 15 minutes)'}
            </TooltipContent>
          </Tooltip>
          {embedded ? null : (
            <div className="hidden items-center gap-2 md:flex">
              <ColumnPicker columns={columns} onChange={(cols) => onChange({ columns: cols })} />
              <SaveViewButton columns={columns} projectId={projectId} q={q} range={range} />
              <ExportMenu projectId={projectId} q={effectiveQ} range={range} />
            </div>
          )}
        </div>
        <div className="flex items-center justify-between gap-3 text-muted-foreground text-xs">
          <span className="tabular-nums" aria-live="polite">
            {events.isPending ? (
              'Searching…'
            ) : (
              <>
                <span className="font-medium text-foreground">
                  {total >= 10_000 && events.hasNextPage ? `${formatNumber(total)}+` : formatNumber(total)}
                </span>{' '}
                events · {rangeLabel(range)}
                {events.data?.pages[0] ? ` · ${Math.round(events.data.pages[0].tookMs)} ms` : ''}
                {events.isFetching && !events.isFetchingNextPage ? ' · refreshing…' : ''}
              </>
            )}
          </span>
          <button className="flex items-center gap-1 hover:text-foreground" onClick={() => setShowChart((s) => !s)} type="button">
            <ChevronDownIcon className={cn('size-3.5 transition-transform', !showChart && '-rotate-90')} />
            {showChart ? 'Hide chart' : 'Show chart'}
          </button>
        </div>
        {showChart ? (
          <EventHistogram
            data={histogram.data}
            height={embedded ? 96 : 112}
            loading={histogram.isFetching && !histogram.isPending}
            onZoom={(from, to) => onChange({ range: absoluteRange(from, to), live: undefined })}
          />
        ) : null}
      </div>

      <div className="flex min-h-0 flex-1">
        {facetsOpen ? <div className="hidden w-60 shrink-0 border-e lg:flex lg:flex-col">{facetsPanel}</div> : null}
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          {liveActive && liveRows.length > 0 ? (
            <div className="pointer-events-none absolute inset-x-0 top-10 z-20 flex justify-center">
              <span className="pointer-events-auto flex items-center gap-1.5 rounded-full border bg-popover px-3 py-1 text-xs shadow-md">
                <ArrowUpIcon className="size-3" />
                {formatNumber(liveRows.length)} new since live started
              </span>
            </div>
          ) : null}
          <EventsTable
            columns={columns}
            cursorIndex={ev ? selectedIndex : cursor}
            empty={empty}
            fetchingMore={events.isFetchingNextPage}
            freshIds={fresh}
            hasMore={events.hasNextPage}
            loadMore={() => events.fetchNextPage()}
            loading={events.isPending}
            onSelect={(e) => {
              setCursor(rows.indexOf(e));
              select(e);
            }}
            rows={rows}
            selectedId={ev}
            total={total}
          />
        </div>
      </div>

      <EventSheet
        event={selected}
        onFilter={(term) => {
          addFilter(term);
        }}
        onNext={selectedIndex >= 0 && selectedIndex < rows.length - 1 ? () => move(1) : undefined}
        onOpenChange={(open) => {
          if (!open) select(null);
        }}
        onPrev={selectedIndex > 0 ? () => move(-1) : undefined}
        missingError={deepLinked.isError ? deepLinked.error : undefined}
        open={Boolean(ev)}
        projectId={projectId}
      />

      <Sheet onOpenChange={setMobileFacets} open={mobileFacets}>
        <SheetContent className="w-[85vw] max-w-xs p-0" side="left">
          <SheetTitle className="sr-only">Filters</SheetTitle>
          <div className="flex h-full flex-col overflow-y-auto pt-10">{facetsPanel}</div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
