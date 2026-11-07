// biome-ignore-all lint/a11y/useSemanticElements: rows are virtualized, absolutely positioned divs; ARIA table roles keep the grid accessible
// biome-ignore-all lint/a11y/useFocusableInteractive: rows are activated by click or by the explorer's j/k + Enter shortcuts

import type { AuditEvent } from '@logbird/contracts';
import { OutcomeDot } from '@logbird/ui/components/badges';
import { Skeleton } from '@logbird/ui/components/ui/skeleton';
import { useIsMobile } from '@logbird/ui/hooks/use-mobile';
import { cn } from '@logbird/ui/lib/utils';
import { type ColumnDef, columnVisibilityFeature, createColumnHelper, tableFeatures, useTable } from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Loader2Icon } from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useRef } from 'react';
import { ActionName } from '@/components/action-name';
import { EventListProjectContext, JobHint, SupportMarker } from '@/components/impersonation';
import { Timestamp } from '@/components/timestamp';
import { eventSentence } from '@/lib/events';
import { formatNumber } from '@/lib/format';
import { placeholderKeys } from '@/lib/placeholders';
import { EVENT_COLUMNS } from './columns';

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

interface EventsTableProps {
  /** Lets row cells link (the "via support" marker → the agent's page). */
  projectId?: string;
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
  /** Index the keyboard cursor sits on (for j/k). */
  cursorIndex?: number;
}

/** Virtualized, infinite event table. TanStack Table owns the column model; TanStack Virtual the rows. */
export function EventsTable({
  projectId,
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

  const virtualizer = useVirtualizer({
    count: tableRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: 12,
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
    <EventListProjectContext value={projectId}>
      <div className={cn('relative flex min-h-0 flex-1 flex-col', className)}>
        <div aria-label="Events" aria-rowcount={total ?? rows.length} className="min-h-0 flex-1 overflow-auto" ref={scrollRef} role="table">
          {isMobile ? null : (
            <div className="sticky top-0 z-10 border-b bg-background/95 backdrop-blur" role="rowgroup" style={{ minWidth }}>
              <div
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
                  aria-selected={selected}
                  className={cn(
                    'absolute inset-x-0 cursor-pointer border-b border-border/60 px-2 text-[13px] outline-none transition-colors hover:bg-muted/50',
                    selected && 'bg-brand/[0.08] hover:bg-brand/[0.1]',
                    isCursor && !selected && 'bg-muted/60',
                    freshIds?.has(e.id) && 'tm-row-new',
                    isMobile ? 'flex flex-col justify-center gap-1 py-2' : 'grid items-center',
                  )}
                  data-index={item.index}
                  key={row.id}
                  onClick={() => onSelect(e)}
                  onKeyDown={(ev) => {
                    if (ev.key === 'Enter') onSelect(e);
                  }}
                  role="row"
                  style={{ height: item.size, transform: `translateY(${item.start}px)`, gridTemplateColumns: isMobile ? undefined : template }}
                  tabIndex={-1}
                >
                  {isMobile ? (
                    <>
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
                    </>
                  ) : (
                    row.getVisibleCells().map((cell) => (
                      <div className="flex min-w-0 items-center overflow-hidden px-2" key={cell.id} role="cell">
                        <table.FlexRender cell={cell} />
                      </div>
                    ))
                  )}
                </div>
              );
            })}
          </div>
          <div className="flex h-12 items-center justify-center text-muted-foreground text-xs">
            {fetchingMore ? (
              <span className="flex items-center gap-2">
                <Loader2Icon className="size-3.5 animate-spin" /> Loading more…
              </span>
            ) : hasMore ? (
              <button className="hover:text-foreground" onClick={loadMore} type="button">
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
    </EventListProjectContext>
  );
}
