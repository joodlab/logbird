import type { AuditEvent, EntityKind, HistogramResponse, QueryLang, SearchResponse } from '@logbird/contracts';
import { StableText } from '@logbird/ui/components/stable-text';
import { EmptyState, ErrorState } from '@logbird/ui/components/states';
import { Button } from '@logbird/ui/components/ui/button';
import { Sheet, SheetContent, SheetTitle } from '@logbird/ui/components/ui/sheet';
import { Switch } from '@logbird/ui/components/ui/switch';
import { Tooltip, TooltipContent, TooltipTrigger } from '@logbird/ui/components/ui/tooltip';
import { cn } from '@logbird/ui/lib/utils';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { ArrowUpIcon, ChevronDownIcon, CircleAlertIcon, FilterIcon, PanelLeftCloseIcon, PanelLeftOpenIcon, SearchXIcon } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { EventHistogram } from '@/components/charts/event-histogram';
import { EventListContext } from '@/components/impersonation';
import { QueryInput, type QueryInputHandle } from '@/components/query-input/query-input';
import { TimeZoneInline } from '@/components/time-zone-control';
import { api, langParam } from '@/lib/api/client';
import { awaiting, current } from '@/lib/api/current';
import { entitySearchQuery, eventQuery, eventsInfiniteQuery, histogramQuery } from '@/lib/api/queries';
import { ENTITY_SECTIONS, entityMatchRank, entityQuery, idFromFreeText, isExactId, sectionForKind } from '@/lib/entities';
import { formatNumber } from '@/lib/format';
import { queryProblem, queryProblemText, reasonTitle, scopedQueryProblem } from '@/lib/query-error';
import { andQuery, scopedQuery } from '@/lib/query-language';
import { translateQueryToSql } from '@/lib/query-translate';
import { ALL_RANGE, absoluteRange, isValidRange, rangeInSentence, rangeLabel, resolveRange } from '@/lib/range';
import { explorerTotal, formatSearchTotal, searchTotal } from '@/lib/search-total';
import { appendSqlPredicate } from '@/lib/sql-language';
import { useConsoleZone } from '@/lib/time-zone';
import { EventSheet } from './event-sheet';
import { EventsTable, type EventsTableHandle } from './events-table';
import { ColumnPicker, ExplorerOverflowMenu, ExportMenu, SaveViewButton } from './explorer-toolbar';
import { FacetSidebar } from './facet-sidebar';

export interface ExplorerState {
  q: string;
  /** Language of `q`; absent = the query language. */
  lang?: QueryLang;
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
  /** Offer SQL mode. Off for embedded timelines: their locked base filter is query language. */
  allowSql?: boolean;
  /** How to name the range in counts and empty states, when the range string is not what the reader chose ("All history"). */
  rangeLabel?: string;
  /** The range already covers everything there is (an entity's full history): never suggest widening it. */
  rangeComplete?: boolean;
  className?: string;
}

const FACETS_KEY = 'logbird.explorer.facets';
const EMPTY_ROWS: AuditEvent[] = [];

/**
 * The `EventsTable` result-set key: every input of the events query. That is the project, the range and the effective
 * query, including an entity page's `baseQuery`. The language only matters when there is a query to parse.
 */
export function explorerResultKey(projectId: string, range: string, effectiveQ: string, lang: QueryLang): string {
  return JSON.stringify([projectId, range, effectiveQ, effectiveQ ? lang : 'query']);
}

function newestArrival(events: AuditEvent[]): string | undefined {
  return events.reduce<string | undefined>((max, e) => (!max || e.receivedAt > max ? e.receivedAt : max), undefined);
}

/** "tenant", "actor", "executor", "record": what the reader calls each kind. */
function kindNoun(kind: EntityKind): string {
  return ENTITY_SECTIONS[sectionForKind(kind)].singular.toLowerCase();
}
function articleFor(kind: EntityKind): string {
  return /^[aeiou]/.test(kindNoun(kind)) ? 'an' : 'a';
}

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return Boolean(el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable || el.closest('[role=dialog]')));
}

/** `o` opens the cursor row only from the page or the grid itself, never while another control has focus. */
function isPageOrRow(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !el || el === document.body || el.getAttribute('role') === 'row';
}

/**
 * One explorer instance per project. Live-tail rows, the last successful result (shown while a query is rejected),
 * the selection and gestures all live inside it, so none of them can outlive a project switch and show or open
 * project A's events under project B.
 */
export function Explorer(props: ExplorerProps) {
  return <ProjectExplorer key={props.projectId} {...props} />;
}

function ProjectExplorer({
  projectId,
  state,
  onChange,
  baseQuery,
  baseLabel,
  embedded = false,
  allowSql = !embedded && !baseQuery,
  rangeLabel: rangeLabelOverride,
  rangeComplete = false,
  className,
}: ExplorerProps) {
  useConsoleZone(); // Range labels and times read the console zone: re-render when the reader switches it.
  const { q, range, columns, ev, live } = state;
  const rangeName = rangeLabelOverride ?? rangeLabel(range);
  const complete = rangeComplete || range === ALL_RANGE;
  const lang: QueryLang = allowSql && state.lang === 'sql' ? 'sql' : 'query';
  // The base filter (an entity or support agent) must constrain all of `q`: `scopedQuery` combines it only when `q`
  // parses, as one group. A `q` that does not parse is never sent (`blocked`); the bar shows its parse error.
  const scoped = scopedQuery(baseQuery ?? '', q);
  const blocked = scoped.problem !== null;
  const effectiveQ = scoped.q ?? '';
  const queryBar = useRef<QueryInputHandle>(null);
  const results = useRef<HTMLDivElement>(null);
  const eventsTable = useRef<EventsTableHandle>(null);
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
  // The keyboard cursor, by event id: it stays on its event when live tail prepends rows.
  const [cursorId, setCursorId] = useState<string | null>(null);

  const events = useInfiniteQuery({ ...eventsInfiniteQuery(projectId, range, effectiveQ, lang), enabled: !blocked });
  // Round bucket sizes (30 min for 24 h, 3 h for 7 d) so bars line up with the axis ticks.
  const histogram = useQuery({ ...histogramQuery(projectId, range, effectiveQ, lang), enabled: !blocked });

  /* ---------------- query errors ---------------- */
  // A rejected query keeps the last good results on screen (dimmed) and explains itself in the bar.
  const problem = scopedQueryProblem(scoped, queryProblem(events.error, lang) ?? queryProblem(histogram.error, lang));
  const lastGood = useRef<{
    pages?: SearchResponse[];
    histogram?: HistogramResponse;
    query?: { q: string; lang: QueryLang };
    range?: string;
    /** The locked filter (an entity page's) the last good result was searched with. */
    base?: string;
    /** The range and locked filter each part was searched over: rows and bars arrive independently. */
    pagesScope?: string;
    histogramScope?: string;
    resultKey?: string;
  }>({});
  // Only settled results become "last good" (a placeholder is another search's data).
  // The project is part of it: a fallback never shows another project's rows, even if this component stays mounted.
  const scope = JSON.stringify([projectId, range, baseQuery ?? '']);
  // A blocked search fetched nothing: whatever is cached under its blank key is never this search's (nor last good).
  const eventsNow = blocked ? undefined : current(events);
  if (eventsNow && !events.isError) {
    lastGood.current.pages = eventsNow.pages;
    lastGood.current.pagesScope = scope;
  }
  if (!blocked && events.isSuccess && !events.isPlaceholderData) {
    lastGood.current.base = baseQuery ?? '';
    lastGood.current.query = { q, lang };
    lastGood.current.range = range;
    lastGood.current.resultKey = explorerResultKey(projectId, range, effectiveQ, lang);
  }
  // The result set the table shows: it changes only when non-placeholder results for a new project, query, language or
  // range are committed, so the table starts that set at the top even when it shares rows with the old one (e.g. moving
  // between two entity profiles, where `q` stays empty but `baseQuery` changes).
  const resultKey = lastGood.current.resultKey;
  const histogramNow = blocked ? undefined : current(histogram);
  if (histogramNow && !histogram.isError) {
    lastGood.current.histogram = histogramNow;
    lastGood.current.histogramScope = scope;
  }
  // A rejected query falls back to the last good result only when it was searched over this same range and locked
  // filter (the query itself is what was rejected): never another range's or another entity's rows or bars.
  const fallbackPages = problem && lastGood.current.pagesScope === scope ? lastGood.current.pages : undefined;
  const fallbackHistogram = problem && lastGood.current.histogramScope === scope ? lastGood.current.histogram : undefined;
  // Nothing valid to save or export while the query is rejected (the export would fail the same way).
  const saveBlocked = problem ? 'Fix the query first — a view must run without errors.' : null;
  const exportBlocked = problem ? 'Fix the query first — the export runs the same query.' : null;
  // Rows from a previous search (a placeholder while the new range or query loads) are never shown or selectable as
  // this one's; a rejected query keeps the last good rows, labelled as such.
  const pages = problem ? fallbackPages : current(events)?.pages;
  const resultsLoading = awaiting(events) && !problem;
  // A rejected query shows the last good bars, labelled as such; otherwise bars from a previous search (a placeholder
  // while the new range or query loads) are never drawn as if they were this one's.
  const histogramData = problem ? fallbackHistogram : current(histogram);

  /* ---------------- live tail ---------------- */
  const relative = isValidRange(range) && !range.includes('..');
  const liveActive = live && relative;
  // Streamed rows belong to one search (project, range, query, language): they are only ever shown with that search.
  const liveKey = `${explorerResultKey(projectId, range, effectiveQ, lang)}|${live}`;
  const [liveBuffer, setLiveBuffer] = useState<{ key: string; rows: AuditEvent[] }>({ key: liveKey, rows: [] });
  const liveRows = liveBuffer.key === liveKey ? liveBuffer.rows : EMPTY_ROWS;
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const sinceRef = useRef<string | null>(null);
  const liveRowsRef = useRef<AuditEvent[]>([]);
  liveRowsRef.current = liveRows;
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset the tail whenever the result set identity changes
  useEffect(() => {
    setLiveBuffer({ key: liveKey, rows: [] });
    sinceRef.current = null;
  }, [effectiveQ, lang, range, live]);

  // The tail follows *arrival* (`receivedAt`), so late or back-dated events still stream in.
  const firstPage = problem ? undefined : current(events)?.pages[0]?.data;
  const firstPageTook = current(events)?.pages[0]?.tookMs;
  useEffect(() => {
    if (!sinceRef.current && firstPage) sinceRef.current = newestArrival(firstPage) ?? new Date().toISOString();
  }, [firstPage]);

  useQuery({
    queryKey: ['projects', projectId, 'live-tail', effectiveQ, lang, range],
    enabled: liveActive && Boolean(firstPage),
    refetchInterval: 2500,
    refetchIntervalInBackground: false,
    gcTime: 0,
    queryFn: async ({ signal }) => {
      const since = sinceRef.current ?? new Date().toISOString();
      // `since` is inclusive, so the newest known arrivals come back too: dedupe by id.
      const data = await api.events.live(
        projectId,
        { since, q: effectiveQ || undefined, lang: effectiveQ ? langParam(lang) : undefined, limit: 100 },
        signal,
      );
      const known = new Set([...(firstPage ?? []), ...liveRowsRef.current].map((e) => e.id));
      const incoming = data.filter((e) => !known.has(e.id));
      sinceRef.current = newestArrival(data) ?? since;
      if (incoming.length) {
        setLiveBuffer((prev) => ({ key: liveKey, rows: [...incoming, ...(prev.key === liveKey ? prev.rows : [])].slice(0, 2000) }));
        setFresh(new Set(incoming.map((e) => e.id)));
      }
      return incoming.length;
    },
  });

  const rows = useMemo(() => {
    const paged = pages?.flatMap((p) => p.data) ?? [];
    if (!liveRows.length) return paged;
    const seen = new Set(liveRows.map((e) => e.id));
    return [...liveRows, ...paged.filter((e) => !seen.has(e.id))];
  }, [pages, liveRows]);
  // Search totals are capped for huge ranges; the histogram counts every match exactly.
  const pagedCount = pages?.reduce((n, p) => n + p.data.length, 0) ?? 0;
  const known = searchTotal(pages, pagedCount, events.hasNextPage);
  const histogramTotal =
    histogramData && (problem || !histogram.isPlaceholderData) ? histogramData.buckets.reduce((n, b) => n + b.total, 0) : undefined;
  const label = explorerTotal({ histogramTotal, search: known, pagedCount, hasNextPage: events.hasNextPage, visibleRows: rows.length });
  const total = label.count;
  const totalLowerBound = !label.exact;

  /* ---------------- selection ---------------- */
  const selectedIndex = ev ? rows.findIndex((e) => e.id === ev) : -1;
  const selectedFromRows = selectedIndex >= 0 ? rows[selectedIndex] : undefined;
  const deepLinked = useQuery({ ...eventQuery(projectId, ev ?? ''), enabled: Boolean(ev) && !selectedFromRows && !events.isPending });
  const selected = selectedFromRows ?? deepLinked.data?.event ?? null;

  const select = useCallback((e: AuditEvent | null) => onChange({ ev: e?.id }), [onChange]);
  // Row cells link support markers to the agent page and place them by the visible columns.
  const listContext = useMemo(() => ({ projectId, columns }), [projectId, columns]);
  // The table moves the cursor onto the open event itself (clicks, j/k in the sheet, deep links), so closing the sheet
  // returns focus to it.
  const cursorIndex = cursorId ? rows.findIndex((e) => e.id === cursorId) : -1;
  const move = useCallback(
    (delta: number) => {
      if (rows.length === 0) return;
      const from = ev ? selectedIndex : cursorIndex;
      const next = Math.min(rows.length - 1, Math.max(0, (from < 0 ? -1 : from) + delta));
      const target = rows[next];
      if (!target) return;
      setCursorId(target.id);
      if (ev) select(target);
      // With the sheet closed, j/k move real focus through the grid (the sheet keeps focus while it is open).
      else eventsTable.current?.focusRow(next);
    },
    [rows, ev, selectedIndex, cursorIndex, select],
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
      } else if (event.key === 'o' && cursorIndex >= 0 && !ev && isPageOrRow(event.target)) {
        // Enter on a focused row is handled by the grid itself.
        event.preventDefault();
        select(rows[cursorIndex] ?? null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [move, cursorIndex, ev, rows, select]);

  /** "Filter by this value" from the event sheet: a query term, translated to a predicate in SQL mode. */
  const addFilter = (term: string) => {
    if (lang !== 'sql') {
      onChange({ q: andQuery(q, term), ev: undefined });
      return;
    }
    const predicate = translateQueryToSql(term);
    if (predicate) onChange({ q: appendSqlPredicate(q, predicate), ev: undefined });
    else toast.error('This filter has no SQL equivalent', { description: `Switch to Query mode to filter by ${term}.` });
  };

  /* ---------------- empty results: say why, and offer only what would find something ---------------- */
  const showsEmpty = Boolean(pages) && !problem && !events.isError && rows.length === 0;
  // A bare word that is exactly an entity's id: free text searches names and descriptions, never ids.
  const word = lang === 'query' ? idFromFreeText(q) : '';
  const idLookup = useQuery({ ...entitySearchQuery(projectId, word), enabled: showsEmpty && Boolean(word) });
  // Every kind with exactly this id (an actor and a tenant can share one): offer each.
  const idMatches = word ? (idLookup.data?.entities ?? []).filter((e) => isExactId(entityMatchRank(e, word))).slice(0, 4) : [];
  const idMatch = idMatches[0];
  // "a tenant id", or "the id of a tenant and an actor".
  const idPhrase =
    idMatches.length === 1 && idMatch
      ? `${articleFor(idMatch.kind)} ${kindNoun(idMatch.kind)} id`
      : `the id of ${idMatches.map((e) => `${articleFor(e.kind)} ${kindNoun(e.kind)}`).join(' and ')}`;
  const idSettled = !word || idLookup.isSuccess || idLookup.isError;
  // Whether anything older matches: only then is the range the reason, and only then is widening offered.
  const wider = useQuery({
    ...histogramQuery(projectId, ALL_RANGE, effectiveQ, lang),
    enabled: showsEmpty && !complete && idSettled && !idMatch,
  });
  const olderMatches = current(wider)?.buckets.reduce((n, b) => n + b.total, 0);
  const widen =
    olderMatches && olderMatches > 0 ? (
      <Button onClick={() => onChange({ range: ALL_RANGE })} size="sm" variant="outline">
        Search all time
      </Button>
    ) : wider.isError ? (
      <Button onClick={() => wider.refetch()} size="sm" variant="outline">
        Retry the check
      </Button>
    ) : null;
  // What the empty state can say about other dates: matches outside the range, none anywhere, or that it could not tell.
  const outside = wider.isError
    ? 'Could not check other dates.'
    : olderMatches
      ? `${formatNumber(olderMatches)} ${olderMatches === 1 ? 'event matches' : 'events match'} outside this range.`
      : 'Remove a filter or change the query.';

  const empty = problem ? (
    <EmptyState description="Fix the query above to see results." icon={SearchXIcon} title="Query not run" />
  ) : events.isError ? (
    <ErrorState error={events.error} onRetry={() => events.refetch()} title="Search failed" />
  ) : (
    <EmptyState
      description={
        idMatch ? (
          <>
            <span className="font-mono text-foreground">{word}</span> is {idPhrase}. Free text searches names and descriptions, not ids.
          </>
        ) : q ? (
          <>
            Nothing in <span className="font-medium text-foreground">{rangeInSentence(rangeName)}</span> matches{' '}
            <span className="font-mono text-foreground">{q}</span>. {outside}
          </>
        ) : wider.isError ? (
          `No events in ${rangeInSentence(rangeName)}. Could not check other dates.`
        ) : olderMatches ? (
          `No events in ${rangeInSentence(rangeName)}. ${formatNumber(olderMatches)} ${olderMatches === 1 ? 'event is' : 'events are'} stored outside it.`
        ) : complete || olderMatches === 0 ? (
          `No events in ${rangeInSentence(rangeName)}. Send events with your ingest key to see them here.`
        ) : (
          `No events in ${rangeInSentence(rangeName)}.`
        )
      }
      icon={SearchXIcon}
      title={q ? 'No matching events' : 'No events in this range'}
    >
      {idMatches.map((e) => (
        <Button key={`${e.kind}:${e.id}`} onClick={() => onChange({ q: entityQuery(e.kind, e.id, e.type) })} size="sm">
          Search <span className="font-mono">{entityQuery(e.kind, e.id, e.type)}</span>
        </Button>
      ))}
      {q ? (
        <Button onClick={() => onChange({ q: '' })} size="sm" variant="outline">
          Clear query
        </Button>
      ) : null}
      {widen}
    </EmptyState>
  );

  const facetsPanel = (
    <FacetSidebar
      // A rejected query has no counts of its own: show the last query that ran, or the whole range on a cold load.
      counts={problem ? (lastGood.current.query ?? { q: '', lang: 'query' }) : undefined}
      staleReason={
        problem
          ? lastGood.current.query
            ? 'This query was not run. Counts are from the last query that ran.'
            : 'This query was not run. Counts cover the whole range.'
          : events.isError
            ? 'The search failed. These counts may not match the current query.'
            : null
      }
      lang={lang}
      onChange={(next) => onChange({ q: next, ev: undefined })}
      projectId={projectId}
      q={q}
      range={range}
      scope={baseQuery}
    />
  );

  return (
    <div className={cn('flex min-h-0 flex-1 flex-col', className)}>
      {/* The page's heading for screen-reader navigation; the visible title is the breadcrumb. */}
      {embedded ? null : <h1 className="sr-only">Events</h1>}
      <div className="flex flex-col gap-2 border-b px-3 py-2.5 sm:px-4">
        <div className="flex flex-wrap items-center gap-2 sm:flex-nowrap">
          {embedded ? null : (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    aria-label={facetsOpen ? 'Hide filters' : 'Show filters'}
                    className="hidden xl:inline-flex"
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
          <Button aria-label="Filters" className="xl:hidden" onClick={() => setMobileFacets(true)} size="icon-sm" variant="outline">
            <FilterIcon />
          </Button>
          {baseQuery ? (
            <span
              className="hidden h-(--control-size-compact) max-w-56 shrink-0 items-center truncate rounded-md border border-dashed bg-muted/40 px-2.5 font-mono text-[12px] text-muted-foreground md:flex"
              title={`Always applied: ${baseQuery}`}
            >
              {baseLabel ?? baseQuery}
            </span>
          ) : null}
          <QueryInput
            allowSql={allowSql}
            className="max-sm:order-last max-sm:basis-full"
            lang={lang}
            onSubmit={(next, nextLang) => onChange({ q: next, lang: nextLang, ev: undefined })}
            placeholder={embedded ? 'Filter this timeline… e.g. outcome:failure attempt:>1' : undefined}
            problem={problem}
            projectId={projectId}
            range={range}
            ref={queryBar}
            size="sm"
            value={q}
            views={!embedded}
          />
          <Tooltip>
            <TooltipTrigger
              render={
                <div
                  className={cn(
                    'flex h-(--control-size-compact) shrink-0 items-center gap-2 rounded-md border px-2.5 text-sm shadow-xs max-sm:ms-auto',
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
                {/* Always laid out (hidden while paused) so toggling never resizes the control or the query bar beside it. */}
                <span
                  aria-hidden
                  className={cn('size-1.5 rounded-full bg-outcome-success text-outcome-success', liveActive ? 'tm-pulse-dot' : 'invisible')}
                />
                Live
              </label>
            </TooltipTrigger>
            <TooltipContent>
              {relative ? 'Stream new events as they arrive' : 'Live tail needs a relative range (e.g. last 15 minutes)'}
            </TooltipContent>
          </Tooltip>
          {embedded ? null : (
            <>
              <div className="hidden items-center gap-2 md:flex">
                <ColumnPicker columns={columns} onChange={(cols) => onChange({ columns: cols })} />
                <SaveViewButton columns={columns} disabledReason={saveBlocked} lang={lang} projectId={projectId} q={q} range={range} />
                <ExportMenu disabledReason={exportBlocked} lang={lang} projectId={projectId} q={effectiveQ} range={range} />
              </div>
              <ExplorerOverflowMenu
                className="md:hidden"
                columns={columns}
                disabledReason={problem ? 'Fix the query first — saving and exporting need a query that runs.' : null}
                exportQ={effectiveQ}
                lang={lang}
                projectId={projectId}
                q={q}
                range={range}
              />
            </>
          )}
        </div>
        <div className="flex items-center justify-between gap-3 text-muted-foreground text-xs">
          <span className={cn('min-w-0 tabular-nums', problem && 'flex items-start gap-1.5 text-destructive sm:items-center')} aria-live="polite">
            {problem ? (
              <>
                <CircleAlertIcon className="mt-px size-3.5 shrink-0 sm:mt-0" />
                {/* Phones wrap: the actionable half of the sentence must not hide behind a hover-only title. */}
                <span className="min-w-0 sm:truncate" data-testid="query-problem" title={queryProblemText(problem, q)}>
                  <span className="font-medium">{reasonTitle(problem.details, problem.code)}</span>
                  {' · '}
                  {queryProblemText(problem, q)}
                </span>
                {problem.code === 'sql_mode_unavailable' ? (
                  <button
                    className="shrink-0 font-medium underline underline-offset-2"
                    onClick={() => onChange({ q: '', lang: 'query' })}
                    type="button"
                  >
                    Use Query mode
                  </button>
                ) : null}
              </>
            ) : awaiting(events) ? (
              'Searching…'
            ) : (
              <>
                <span className="font-medium text-foreground">
                  {totalLowerBound ? formatSearchTotal({ count: total, exact: false }) : formatNumber(total)}
                </span>{' '}
                {!totalLowerBound && total === 1 ? 'event' : 'events'} · {rangeName}
                {firstPageTook !== undefined ? ` · ${Math.round(firstPageTook)} ms` : ''}
                {events.isFetching && !events.isFetchingNextPage ? ' · refreshing…' : ''}
              </>
            )}
            {/* Below md the table has no column header (useIsMobile): name the zone here (and switch it) in every state,
                including the last good rows shown after a rejected query. */}
            <TimeZoneInline className="md:hidden" />
          </span>
          <button
            aria-expanded={showChart}
            className="-my-2 flex shrink-0 items-center gap-1 py-2 hover:text-foreground pointer-coarse:-my-3.5 pointer-coarse:py-3.5"
            onClick={() => setShowChart((s) => !s)}
            type="button"
          >
            <ChevronDownIcon className={cn('size-3.5 transition-transform', !showChart && '-rotate-90')} />
            <StableText reserve={['Hide chart', 'Show chart']}>{showChart ? 'Hide chart' : 'Show chart'}</StableText>
          </button>
        </div>
        {showChart ? (
          <EventHistogram
            // A new search (or Back to a cached one) starts with no drag in progress.
            key={explorerResultKey(projectId, range, effectiveQ, lang)}
            data={histogramData}
            height={embedded ? 96 : 112}
            loading={histogram.isFetching && !histogram.isPending}
            onZoom={
              // Bars from the previous range linger while the new one loads: no zooming on them.
              histogram.isPlaceholderData
                ? undefined
                : (from, to) => {
                    // Keep the selection inside the search that produced the visible bars (its end can lie ahead of
                    // now, and a relative range has moved on since).
                    const shown = current(histogram) ?? resolveRange(range);
                    const start = Math.max(from, shown.fromMs);
                    const end = Math.min(to, shown.toMs);
                    if (start < end) onChange({ range: absoluteRange(start, end), live: undefined });
                  }
            }
            stale={Boolean(problem)}
          />
        ) : null}
      </div>

      <div className="flex min-h-0 flex-1">
        {facetsOpen ? (
          <div className="relative hidden w-60 shrink-0 border-e xl:flex xl:flex-col">
            {/* The facet list is dozens of Tab stops: let keyboard users jump past it to the events (shown on focus). */}
            {rows.length ? (
              <button
                className="sr-only rounded-md border bg-popover px-2.5 py-1.5 text-xs shadow-md outline-none focus-visible:outline-hidden focus-visible:not-sr-only focus-visible:absolute focus-visible:start-2 focus-visible:top-2 focus-visible:z-30 focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => eventsTable.current?.focusCursor()}
                type="button"
              >
                Skip filters to events
              </button>
            ) : null}
            {facetsPanel}
          </div>
        ) : null}
        <div
          className={cn('relative flex min-h-0 min-w-0 flex-1 flex-col outline-none transition-opacity', problem && rows.length > 0 && 'opacity-45')}
          ref={results}
          tabIndex={-1}
        >
          {liveActive && liveRows.length > 0 ? (
            <div className="pointer-events-none absolute inset-x-0 top-10 z-20 flex justify-center">
              <span className="pointer-events-auto flex items-center gap-1.5 rounded-full border bg-popover px-3 py-1 text-xs shadow-md">
                <ArrowUpIcon className="size-3" />
                {formatNumber(liveRows.length)} new since live started
              </span>
            </div>
          ) : null}
          <EventListContext value={listContext}>
            <EventsTable
              columns={columns}
              cursorId={cursorId}
              empty={empty}
              fetchingMore={events.isFetchingNextPage}
              // A refetch emptied the list while a row had focus: back to the query, the way to widen it.
              focusFallback={() => queryBar.current?.element()}
              freshIds={fresh}
              hasMore={!problem && events.hasNextPage}
              loadMore={() => events.fetchNextPage()}
              loading={resultsLoading}
              onCursorChange={setCursorId}
              resultKey={resultKey}
              onSelect={(e) => {
                setCursorId(e.id);
                select(e);
              }}
              ref={eventsTable}
              rows={rows}
              selectedId={ev}
              total={total}
            />
          </EventListContext>
        </div>
      </div>

      <EventSheet
        event={selected}
        // Back to the row the sheet showed last (it may differ from the one opened, after j/k): never to <body>.
        // With no rows left (a refetch emptied the list meanwhile), to the query bar.
        // Back to the row; while the new result loads (no rows yet), to the results region, never away to the query bar.
        finalFocus={() => eventsTable.current?.cursorElement() ?? (resultsLoading ? results.current : null) ?? queryBar.current?.element() ?? true}
        onFilter={(term) => {
          addFilter(term);
        }}
        onNext={selectedIndex >= 0 && selectedIndex < rows.length - 1 ? () => move(1) : undefined}
        onOpenChange={(open) => {
          if (!open) select(null);
        }}
        onPrev={selectedIndex > 0 ? () => move(-1) : undefined}
        missingError={deepLinked.isError ? deepLinked.error : undefined}
        missingId={ev}
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
