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
import { type KeyboardEvent, type ReactNode, type Ref, useCallback, useEffect, useImperativeHandle, useMemo, useRef } from 'react';
import { ActionName } from '@/components/action-name';
import { Timestamp } from '@/components/timestamp';
import { eventSentence } from '@/lib/events';
import { formatNumber } from '@/lib/format';
import { placeholderKeys } from '@/lib/placeholders';
import { EVENT_COLUMNS } from './columns';
import { eventRowLabel, nextRowIndex } from './row-navigation';

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
  /** Move the roving focus to a row, scrolling it into view; false when there is no such row. */
  focusRow: (index: number) => boolean;
  /** The mounted row element at `index`, if any (to return focus to when a dialog closes). */
  rowElement: (index: number) => HTMLElement | null;
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
  /** Index the keyboard cursor sits on (for j/k). It is also the grid's roving tab stop. */
  cursorIndex?: number;
  /** The roving focus moved to another row (arrow keys, click, Tab into the grid). */
  onCursorChange?: (index: number) => void;
  ref?: Ref<EventsTableHandle>;
}

/**
 * Virtualized, infinite event table. TanStack Table owns the column model; TanStack Virtual the rows.
 *
 * Accessibility: an ARIA grid with a roving tab stop on the rows. Tab enters the grid on the cursor row; ↑/↓,
 * PageUp/PageDown and Home/End move focus between rows; Enter or Space opens the row. The focused row stays mounted
 * even when it is scrolled away, so focus never falls back to <body>.
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
  cursorIndex,
  onCursorChange,
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
  const tabStop = count ? Math.min(Math.max(cursorIndex ?? 0, 0), count - 1) : -1;
  // Keep the tab stop rendered while it is scrolled out of view: Tab can always reach the grid, and the row a dialog
  // returns focus to exists.
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
  const lastIndex = items.at(-1)?.index ?? 0;

  useEffect(() => {
    if (hasMore && !fetchingMore && lastIndex >= tableRows.length - 15) loadMore?.();
  }, [hasMore, fetchingMore, lastIndex, tableRows.length, loadMore]);

  useEffect(() => {
    if (cursorIndex !== undefined && cursorIndex >= 0) virtualizer.scrollToIndex(cursorIndex, { align: 'auto' });
  }, [cursorIndex, virtualizer]);

  useEffect(() => {
    if (rowHeight > 0) virtualizer.measure();
  }, [rowHeight, virtualizer]);

  /* ---------------- roving focus ---------------- */
  const pendingFocus = useRef<number | null>(null);
  const rowElement = useCallback((index: number) => scrollRef.current?.querySelector<HTMLElement>(`[role="row"][data-index="${index}"]`) ?? null, []);
  const focusRow = useCallback(
    (index: number) => {
      if (index < 0 || index >= count) return false;
      if (index !== cursorIndex) onCursorChange?.(index);
      virtualizer.scrollToIndex(index, { align: 'auto' });
      const el = rowElement(index);
      if (el) el.focus({ preventScroll: true });
      // Not rendered yet (a far jump): focus it as soon as the virtualizer mounts it.
      else pendingFocus.current = index;
      return true;
    },
    [count, cursorIndex, onCursorChange, virtualizer, rowElement],
  );
  useEffect(() => {
    const index = pendingFocus.current;
    if (index === null) return;
    const el = rowElement(index);
    if (el) {
      pendingFocus.current = null;
      el.focus({ preventScroll: true });
    }
  });
  useImperativeHandle(ref, () => ({ focusRow, rowElement }), [focusRow, rowElement]);

  const onRowKeyDown = (ev: KeyboardEvent<HTMLDivElement>, index: number, e: AuditEvent) => {
    // Keys pressed on a control inside a cell (a link) belong to that control.
    if (ev.target !== ev.currentTarget || ev.altKey || ev.ctrlKey || ev.metaKey) return;
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
              const isCursor = item.index === cursorIndex;
              return (
                <div
                  aria-label={eventRowLabel(e)}
                  aria-rowindex={item.index + (isMobile ? 1 : 2)}
                  aria-selected={selected}
                  className={cn(
                    'absolute inset-x-0 cursor-pointer border-b border-border/60 px-2 text-[13px] outline-none transition-colors hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset',
                    selected && 'bg-brand/[0.08] hover:bg-brand/[0.1]',
                    isCursor && !selected && 'bg-muted/60',
                    freshIds?.has(e.id) && 'tm-row-new',
                    isMobile ? 'flex flex-col justify-center gap-1 py-2' : 'grid items-center',
                  )}
                  data-index={item.index}
                  key={row.id}
                  onClick={() => onSelect(e)}
                  onFocus={(ev) => {
                    if (ev.target === ev.currentTarget && item.index !== cursorIndex) onCursorChange?.(item.index);
                  }}
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
                    <div className="contents" role="gridcell">
                      <span className="flex min-w-0 items-center gap-2">
                        <OutcomeDot outcome={e.outcome} />
                        <span className="truncate" dir="auto">
                          {eventSentence(e)}
                        </span>
                      </span>
                      <span className="flex min-w-0 items-center gap-2 ps-4 text-muted-foreground text-xs">
                        <Timestamp className="shrink-0" iso={e.timestamp} />
                        <ActionName action={e.action} className="text-[11px]" />
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
