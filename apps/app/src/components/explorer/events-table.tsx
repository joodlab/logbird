// biome-ignore-all lint/a11y/useSemanticElements: rows are virtualized, absolutely positioned divs; ARIA grid roles keep them accessible
// biome-ignore-all lint/a11y/useFocusableInteractive: a row-focus grid: the body rows carry the roving tabindex; the header row, column headers and cells are not tab stops

import type { AuditEvent } from '@logbird/contracts';
import { OutcomeDot } from '@logbird/ui/components/badges';
import { Skeleton } from '@logbird/ui/components/ui/skeleton';
import { useIsMobile } from '@logbird/ui/hooks/use-mobile';
import { cn } from '@logbird/ui/lib/utils';
import { type ColumnDef, columnVisibilityFeature, createColumnHelper, tableFeatures, useTable } from '@tanstack/react-table';
import { defaultRangeExtractor, type Range, useVirtualizer } from '@tanstack/react-virtual';
import { Loader2Icon } from 'lucide-react';
import {
  type KeyboardEvent,
  type ReactNode,
  type Ref,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { ActionName } from '@/components/action-name';
import { JobHint, SupportMarker } from '@/components/impersonation';
import { Timestamp } from '@/components/timestamp';
import { eventSentence } from '@/lib/events';
import { formatNumber } from '@/lib/format';
import { placeholderKeys } from '@/lib/placeholders';
import { EVENT_COLUMNS } from './columns';
import { anchorShift, eventRowLabel, isReplaced, nextRowIndex, prependedCount, resolveCursor } from './row-navigation';

const features = tableFeatures({ columnVisibilityFeature });
const helper = createColumnHelper<typeof features, AuditEvent>();

const columnDefs = EVENT_COLUMNS.map((c) =>
  helper.display({
    id: c.id,
    header: c.label,
    cell: (ctx) => c.render(ctx.row.original),
    enableHiding: !c.required,
  }),
) as ColumnDef<typeof features, AuditEvent, unknown>[];

const WIDTH = new Map(EVENT_COLUMNS.map((c) => [c.id, c.width]));
/** Height of the sticky column header (h-8). The virtualizer offsets rows by it, so scrolling never parks a row under it. */
const HEADER_HEIGHT = 32;

export interface EventsTableHandle {
  /** Move the roving focus to the row at `index`, scrolling it into view; false when there is no such row. */
  focusRow: (index: number) => boolean;
  /** Focus the cursor row (the grid's tab stop), e.g. from a skip link; false when there are no rows. */
  focusCursor: () => boolean;
  /**
   * The mounted cursor row, to return focus to when a dialog closes. When the cursor's event left the list, the row now
   * in its place; null when there are no rows.
   */
  cursorElement: () => HTMLElement | null;
}

interface EventsTableProps {
  rows: AuditEvent[];
  columns: string[];
  selectedId?: string;
  onSelect: (event: AuditEvent) => void;
  hasMore?: boolean;
  loadMore?: () => void;
  loading?: boolean;
  fetchingMore?: boolean;
  /** Ids that just arrived through live tail (highlighted briefly). */
  freshIds?: ReadonlySet<string>;
  empty?: ReactNode;
  total?: number;
  className?: string;
  /**
   * The keyboard cursor, as an event id: the grid's roving tab stop and the row j/k move from. Pass it with
   * `onCursorChange` to control it; omit it and the table tracks the cursor itself. `null` = no cursor yet (Tab enters on
   * the first row). It follows `selectedId` whenever the selected event is in `rows`.
   */
  cursorId?: string | null;
  /**
   * The cursor moved: to another event (arrow keys, a click, focus, the selection, the row now in its place when its
   * event left while the grid had focus), or to `null` when its event left the list in a new result set, or while focus was elsewhere.
   */
  onCursorChange?: (id: string | null) => void;
  /**
   * Where focus goes when the grid had it and the list becomes empty (a refetch or filter removed every row), e.g. the
   * page's query or search input. Never used while focus is elsewhere.
   */
  focusFallback?: () => HTMLElement | null | undefined;
  /**
   * The row's accessible name. Focus lands on the row (not a cell), so screen readers announce this name rather than the
   * cells: anything meaningful a caller adds to a cell (a marker, a job hint) belongs here too. Defaults to `eventRowLabel`.
   */
  rowLabel?: (event: AuditEvent) => string;
  /**
   * Identifies the result set `rows` belongs to: every input of the query that produced them (project, range, the
   * effective query including any base query, and its language). Change it only when non-placeholder
   * data for a new query is committed: a changed key marks `rows` as a new result set, however many rows it shares with
   * the old one. Without it, a new result set is inferred from the rows (`isReplaced`: the old first row is gone), which
   * misses a new query whose newest match is the old first row.
   */
  resultKey?: string;
  ref?: Ref<EventsTableHandle>;
}

/**
 * Virtualized, infinite event table. TanStack Table owns the column model; TanStack Virtual the rows.
 *
 * Accessibility: an ARIA grid with a roving tab stop on the rows. Tab enters the grid on the cursor row; ↑/↓,
 * PageUp/PageDown and Home/End (or Ctrl+Home/End) move focus between rows; Enter or Space opens the row. The cursor is
 * an event id, so it stays on its event when live tail prepends rows, and its row stays mounted even when scrolled away.
 * When its event leaves the list while the grid has focus, focus moves to the row now in its place (or to
 * `focusFallback` when no row is left), never to <body>. A new result set (`resultKey` changed; without a key, the old
 * first row is gone) starts at the top without loading more: when it no longer holds the cursor's event, the cursor
 * resets to the first row, and a focused grid moves focus there. Only a focused grid follows a cursor whose event moves
 * to another index (other than by a live-tail prepend) and scrolls it into view.
 *
 * In-row controls (a link inside a cell) must follow this contract, because the row's `onClick` opens the event and has
 * no target guard: give them `tabIndex={-1}` (the row is the tab stop; screen readers reach them through the row's
 * cells) and stop click and key propagation (`event.stopPropagation()`) so activating one does not also open the row or
 * move the cursor. Their keys never reach the row's grid keys, and focusing one moves the cursor to — and so keeps
 * mounted — the row that owns it. Anything they convey belongs in `rowLabel` too.
 */
export function EventsTable({
  rows,
  columns,
  selectedId,
  onSelect,
  hasMore,
  loadMore,
  loading,
  fetchingMore,
  freshIds,
  empty,
  total,
  className,
  cursorId,
  onCursorChange,
  rowLabel = eventRowLabel,
  focusFallback,
  resultKey,
  ref,
}: EventsTableProps) {
  const isMobile = useIsMobile();
  const scrollRef = useRef<HTMLDivElement>(null);
  const columnVisibility = useMemo(() => Object.fromEntries(EVENT_COLUMNS.map((c) => [c.id, columns.includes(c.id)])), [columns]);

  const table = useTable({
    features,
    columns: columnDefs,
    data: rows,
    getRowId: (row) => row.id,
    state: { columnVisibility },
  });

  const visible = table.getVisibleLeafColumns();
  const template = visible.map((c) => (WIDTH.get(c.id) === 'flex' ? 'minmax(200px,1fr)' : `${WIDTH.get(c.id)}px`)).join(' ');
  const minWidth = visible.reduce((sum, c) => sum + (WIDTH.get(c.id) === 'flex' ? 200 : Number(WIDTH.get(c.id))), 0) + 16;
  const tableRows = table.getRowModel().rows;
  const rowHeight = isMobile ? 64 : 36;
  const headerHeight = isMobile ? 0 : HEADER_HEIGHT;
  const count = tableRows.length;

  /* ---------------- the cursor (an event id) ---------------- */
  const [ownCursor, setOwnCursor] = useState<string | null>(null);
  const controlled = cursorId !== undefined;
  const cursorKey = controlled ? cursorId : ownCursor;
  const onCursorChangeRef = useRef(onCursorChange);
  onCursorChangeRef.current = onCursorChange;
  const cursorKeyRef = useRef(cursorKey);
  cursorKeyRef.current = cursorKey;
  const setCursor = useCallback(
    (id: string | null) => {
      if (id === cursorKeyRef.current) return;
      cursorKeyRef.current = id;
      if (!controlled) setOwnCursor(id);
      onCursorChangeRef.current?.(id);
    },
    [controlled],
  );
  const lastCursorIndex = useRef(0);
  // Whether focus is in the grid: if the focused row unmounts (its event was filtered out), the grid takes focus back.
  const focusInside = useRef(false);
  // The first row and the result key as last committed. This render is a new result set (a query, facet, range or
  // "Filter by" change) when the consumer's `resultKey` changed; without a key, when the old first row is gone — not a
  // removal within the same list nor a live-tail prepend (which keeps the old first row).
  const firstId = useRef<string | undefined>(undefined);
  const committedKey = useRef(resultKey);
  const replaced =
    resultKey === undefined
      ? isReplaced(firstId.current, rows)
      : rows.length > 0 && committedKey.current !== undefined && committedKey.current !== resultKey;
  // The tab stop: the cursor's row wherever its event is now; the first row while there is no cursor.
  const resolved = resolveCursor(rows, cursorKey, lastCursorIndex.current);
  // The cursor's event is gone. In a new result set, or with focus elsewhere, start over at the top: the old index means
  // nothing there, and following it would scroll the reader away and load another page. Only a focused grid whose own
  // list lost rows (a filter, a refetch) keeps its place: the row now at the cursor's index takes focus.
  const reset = resolved.fallback && (replaced || !focusInside.current);
  const fallback = resolved.fallback && !reset;
  const tabStop = reset ? 0 : resolved.index;
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const tabStopRef = useRef(tabStop);
  tabStopRef.current = tabStop;
  useLayoutEffect(() => {
    if (tabStop >= 0 && !fallback) lastCursorIndex.current = tabStop;
  }, [tabStop, fallback]);
  // The cursor's event left the list (a filter, a refetch): move the cursor for real to the row now in its place.
  const fallbackId = fallback ? rows[tabStop]?.id : undefined;
  useEffect(() => {
    if (fallbackId) setCursor(fallbackId);
  }, [fallbackId, setCursor]);
  // Start over at the top: no cursor (Tab enters on the first row), or the first row itself when the grid kept focus.
  useEffect(() => {
    if (!reset) return;
    lastCursorIndex.current = 0;
    setCursor(focusInside.current ? (rowsRef.current[0]?.id ?? null) : null);
  }, [reset, setCursor]);
  // The cursor follows the open event (clicks, j/k in the sheet, deep links), so closing the sheet returns focus to it.
  useEffect(() => {
    if (selectedId && rows.some((r) => r.id === selectedId)) setCursor(selectedId);
  }, [selectedId, rows, setCursor]);

  // Keep the tab stop rendered while it is scrolled out of view: Tab can always reach the grid, a focused row (or a
  // control inside it) is never unmounted, and the row a dialog returns focus to exists.
  const rangeExtractor = useCallback(
    (range: Range) => {
      const indexes = defaultRangeExtractor(range);
      return tabStop < 0 || indexes.includes(tabStop) ? indexes : [...indexes, tabStop].sort((a, b) => a - b);
    },
    [tabStop],
  );

  const virtualizer = useVirtualizer({
    count,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: 12,
    rangeExtractor,
    scrollMargin: headerHeight,
    scrollPaddingStart: headerHeight,
  });
  const items = virtualizer.getVirtualItems();
  // The viewport's real range, not the retained tab stop: a cursor row kept far below must not trigger loading more.
  const startIndex = virtualizer.range?.startIndex ?? 0;
  const endIndex = virtualizer.range?.endIndex ?? 0;
  // After a new result set the virtualizer still reports the old scroll position until the browser's scroll event
  // arrives: hold off loading more until the viewport shows where the view went — the tab stop it scrolled to, or the
  // top (a new result set while focus is elsewhere).
  const awaiting = useRef<'tabStop' | 'top' | null>(null);

  useEffect(() => {
    if (awaiting.current) {
      const target = awaiting.current === 'top' ? 0 : tabStop;
      if (target >= 0 && (target < startIndex || target > endIndex)) return;
      awaiting.current = null;
    }
    if (hasMore && !fetchingMore && endIndex >= tableRows.length - 15) loadMore?.();
  }, [hasMore, fetchingMore, startIndex, endIndex, tabStop, tableRows.length, loadMore]);

  // Live tail prepends rows: how many arrived in the last commit (0 for anything else).
  const lastPrepended = useRef(0);
  // Scroll the cursor row into view when the cursor moves to another event. When its event moves to another index for any
  // reason but a live-tail prepend (a reordering refetch; a new result set that still holds it; a capped live tail that
  // drops rows above it), follow it only while the grid has focus: with focus elsewhere the row stays mounted off-screen,
  // and Tab or a dialog's return focus brings it into view once it is focused. A prepend only shifts it, and the view is
  // anchored for that below.
  const scrolledTo = useRef<{ key: string | null | undefined; index: number }>({ key: undefined, index: -1 });
  useEffect(() => {
    const previous = scrolledTo.current;
    scrolledTo.current = { key: cursorKey, index: tabStop };
    if (!cursorKey || tabStop < 0) return;
    if (previous.key === cursorKey && (!focusInside.current || tabStop === previous.index + lastPrepended.current)) return;
    virtualizer.scrollToIndex(tabStop, { align: 'auto' });
  }, [cursorKey, tabStop, virtualizer]);

  useEffect(() => {
    if (rowHeight > 0) virtualizer.measure();
  }, [rowHeight, virtualizer]);

  /* ---------------- roving focus ---------------- */
  // An event to focus as soon as its row mounts (a far jump).
  const pendingFocus = useRef<string | null>(null);
  const rowElement = useCallback((index: number) => scrollRef.current?.querySelector<HTMLElement>(`[role="row"][data-index="${index}"]`) ?? null, []);

  // Live tail prepends rows. Unless the reader sits at the top watching them arrive (with focus elsewhere), keep what is
  // on screen — and the focused row — where it is instead of pushing it down: scroll by how far the focused row (or the
  // top row in view) moved, which is less than the batch once the capped tail drops rows above it.
  const previousRows = useRef(rows);
  // A new result set starts at the top, unless a focused grid follows its cursor's event to its new index: with focus
  // elsewhere it goes to the top even when the cursor's event survives. Without the cursor's event, a focused grid moves
  // focus to the first row (the old focused row is gone).
  useLayoutEffect(() => {
    const added = replaced ? 0 : prependedCount(firstId.current, rows);
    const before = previousRows.current;
    lastPrepended.current = added;
    firstId.current = rows[0]?.id;
    previousRows.current = rows;
    if (rows.length > 0) committedKey.current = resultKey;
    const el = scrollRef.current;
    if (!el) return;
    if (added > 0 && (el.scrollTop > 0 || focusInside.current)) {
      const focused = focusInside.current && cursorKey ? before.findIndex((r) => r.id === cursorKey) : -1;
      const anchor = focused >= 0 ? focused : Math.floor(el.scrollTop / rowHeight);
      el.scrollTop += anchorShift(before, rows, anchor, added) * rowHeight;
    }
    if (!replaced) return;
    if (!reset && focusInside.current) {
      // The scroll effect above follows the cursor to its new index: don't load more from the old position meanwhile.
      if (cursorKey && tabStop !== scrolledTo.current.index) awaiting.current = 'tabStop';
      return;
    }
    // To the top, loading no more from the old position either.
    awaiting.current = reset ? 'tabStop' : 'top';
    el.scrollTop = 0;
    if (!reset) return;
    pendingFocus.current = null;
    if (focusInside.current) rowElement(0)?.focus({ preventScroll: true });
  }, [rows, rowHeight, replaced, reset, cursorKey, tabStop, rowElement, resultKey]);

  const focusRow = useCallback(
    (index: number) => {
      const event = rowsRef.current[index];
      if (!event) return false;
      // An explicit move takes the view to this row: stop waiting for it to show the top.
      if (awaiting.current === 'top') awaiting.current = null;
      setCursor(event.id);
      virtualizer.scrollToIndex(index, { align: 'auto' });
      const el = rowElement(index);
      if (el) {
        pendingFocus.current = null;
        el.focus({ preventScroll: true });
      }
      // Not rendered yet (a far jump): focus it as soon as the virtualizer mounts it.
      else pendingFocus.current = event.id;
      return true;
    },
    [setCursor, virtualizer, rowElement],
  );
  const focusFallbackRef = useRef(focusFallback);
  focusFallbackRef.current = focusFallback;
  useLayoutEffect(() => {
    const pending = pendingFocus.current;
    if (pending) {
      const index = rows.findIndex((r) => r.id === pending);
      // Its event left the list: drop the request rather than focus whatever row took its index.
      if (index < 0) pendingFocus.current = null;
      else {
        const el = rowElement(index);
        if (el) {
          pendingFocus.current = null;
          el.focus({ preventScroll: true });
        }
        return;
      }
    }
    // The focused row unmounted (its event was filtered out, the list was replaced) and focus fell to <body>: put it on
    // the tab stop, the row now in the cursor's place.
    const active = document.activeElement;
    if (!focusInside.current || (active && active !== document.body)) return;
    if (tabStop >= 0) rowElement(tabStop)?.focus({ preventScroll: true });
    else if (rows.length === 0) {
      // No row is left to hold focus (the grid itself is gone): hand it to the page's fallback, e.g. the query input.
      focusInside.current = false;
      pendingFocus.current = null;
      focusFallbackRef.current?.()?.focus();
    }
  });
  useImperativeHandle(
    ref,
    () => ({
      focusRow,
      focusCursor: () => focusRow(Math.max(tabStopRef.current, 0)),
      cursorElement: () => (tabStopRef.current >= 0 ? rowElement(tabStopRef.current) : null),
    }),
    [focusRow, rowElement],
  );

  const onRowKeyDown = (ev: KeyboardEvent<HTMLDivElement>, index: number, e: AuditEvent) => {
    // Keys pressed on a control inside a cell (a link) belong to that control.
    if (ev.target !== ev.currentTarget || ev.altKey || ev.metaKey) return;
    // Ctrl+Home/End are the APG grid keys for the first and last row; other Ctrl chords are not ours.
    if (ev.ctrlKey && ev.key !== 'Home' && ev.key !== 'End') return;
    if (ev.key === 'Enter' || ev.key === ' ') {
      ev.preventDefault();
      onSelect(e);
      return;
    }
    const page = Math.max(1, Math.floor((scrollRef.current?.clientHeight ?? rowHeight * 10) / rowHeight) - 2);
    const next = nextRowIndex(ev.key, index, count, page);
    if (next === null) return;
    ev.preventDefault();
    focusRow(next);
  };

  if (loading) {
    return (
      <div aria-busy="true" className={cn('flex flex-col gap-1 p-3', className)}>
        {placeholderKeys(14).map((k, i) => (
          <Skeleton className="h-7 w-full" key={k} style={{ opacity: 1 - i * 0.05 }} />
        ))}
      </div>
    );
  }

  if (rows.length === 0) return <div className={cn('flex flex-1 items-center justify-center', className)}>{empty}</div>;

  return (
    <div className={cn('relative flex min-h-0 flex-1 flex-col', className)}>
      <div className="min-h-0 flex-1 overflow-auto" ref={scrollRef}>
        <div
          aria-colcount={isMobile ? 1 : visible.length}
          aria-label="Events"
          aria-rowcount={Math.max(total ?? 0, count) + (isMobile ? 0 : 1)}
          onBlur={(ev) => {
            const next = ev.relatedTarget as Node | null;
            if (next && ev.currentTarget.contains(next)) return;
            if (next) {
              focusInside.current = false;
              return;
            }
            // No new target: the user left the page, clicked nothing focusable — or the focused row was unmounted, in
            // which case focus is the grid's to restore.
            const lost = ev.target;
            queueMicrotask(() => {
              if (lost.isConnected) focusInside.current = false;
            });
          }}
          onFocus={() => {
            focusInside.current = true;
          }}
          role="grid"
        >
          {isMobile ? null : (
            <div className="sticky top-0 z-10 border-b bg-background/95 backdrop-blur" role="rowgroup" style={{ minWidth }}>
              <div
                aria-rowindex={1}
                className="grid h-8 items-center gap-0 px-2 text-[11px] text-muted-foreground uppercase tracking-wider"
                role="row"
                style={{ gridTemplateColumns: template }}
              >
                {table.getHeaderGroups()[0]?.headers.map((h) => (
                  <div className="truncate px-2 font-medium" key={h.id} role="columnheader">
                    <table.FlexRender header={h} />
                  </div>
                ))}
              </div>
            </div>
          )}
          <div role="rowgroup" style={{ height: virtualizer.getTotalSize(), position: 'relative', minWidth: isMobile ? undefined : minWidth }}>
            {items.map((item) => {
              const row = tableRows[item.index];
              if (!row) return null;
              const e = row.original;
              const selected = e.id === selectedId;
              const isCursor = Boolean(cursorKey) && item.index === tabStop;
              return (
                <div
                  aria-label={rowLabel(e)}
                  aria-rowindex={item.index + (isMobile ? 1 : 2)}
                  className={cn(
                    'absolute inset-x-0 cursor-pointer border-b border-border/60 px-2 text-[13px] outline-none focus-visible:outline-hidden transition-colors hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset focus-visible:forced-colors:-outline-offset-2',
                    selected && 'bg-brand/[0.08] hover:bg-brand/[0.1]',
                    isCursor && !selected && 'bg-muted/60',
                    freshIds?.has(e.id) && 'tm-row-new',
                    isMobile ? 'flex flex-col justify-center gap-1 py-2' : 'grid items-center',
                  )}
                  data-event-id={e.id}
                  data-index={item.index}
                  key={row.id}
                  onClick={() => onSelect(e)}
                  // Also when a control inside the row takes focus: the row then stays mounted with it.
                  onFocus={() => setCursor(e.id)}
                  onKeyDown={(ev) => onRowKeyDown(ev, item.index, e)}
                  role="row"
                  style={{
                    height: item.size,
                    transform: `translateY(${item.start - headerHeight}px)`,
                    gridTemplateColumns: isMobile ? undefined : template,
                  }}
                  tabIndex={item.index === tabStop ? 0 : -1}
                >
                  {isMobile ? (
                    // A real box, not `display: contents`: older WebKit drops those from the accessibility tree, which would
                    // leave the row without its gridcell.
                    <div className="flex min-w-0 flex-col gap-1" role="gridcell">
                      <span className="flex min-w-0 items-center gap-2">
                        <OutcomeDot outcome={e.outcome} />
                        <span className="truncate" dir="auto">
                          {eventSentence(e)}
                        </span>
                      </span>
                      <span className="flex min-w-0 items-center gap-2 ps-4 text-muted-foreground text-xs">
                        <Timestamp className="shrink-0" iso={e.timestamp} />
                        <SupportMarker className="max-w-[11rem]" event={e} />
                        <JobHint compact event={e} />
                        <ActionName action={e.action} className="min-w-0 text-[11px]" />
                      </span>
                    </div>
                  ) : (
                    row.getVisibleCells().map((cell) => (
                      <div className="flex min-w-0 items-center overflow-hidden px-2" key={cell.id} role="gridcell">
                        <table.FlexRender cell={cell} />
                      </div>
                    ))
                  )}
                </div>
              );
            })}
          </div>
        </div>
        <div className="flex h-12 items-center justify-center text-muted-foreground text-xs">
          {fetchingMore ? (
            <span className="flex items-center gap-2">
              <Loader2Icon className="size-3.5 animate-spin" /> Loading more…
            </span>
          ) : hasMore ? (
            <button className="-my-2 px-3 py-3 hover:text-foreground" onClick={loadMore} type="button">
              Load more
            </button>
          ) : (
            <span>
              End of results · {formatNumber(rows.length)} event{rows.length === 1 ? '' : 's'}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
