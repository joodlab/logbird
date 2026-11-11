import type { AuditEvent } from '@logbird/contracts';
import { OutcomeDot, TypePill } from '@logbird/ui/components/badges';
import { CopyValue } from '@logbird/ui/components/copy-button';
import { EmptyState, ErrorState } from '@logbird/ui/components/states';
import { Button } from '@logbird/ui/components/ui/button';
import { Skeleton } from '@logbird/ui/components/ui/skeleton';
import { cn } from '@logbird/ui/lib/utils';
import { useQuery } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { GitBranchIcon, Rows3Icon, SearchXIcon } from 'lucide-react';
import { useMemo } from 'react';
import { z } from 'zod';
import { ActionName } from '@/components/action-name';
import { EntityLink } from '@/components/entity-link';
import { EventSheet } from '@/components/explorer/event-sheet';
import { Timestamp } from '@/components/timestamp';
import { ApiRequestError } from '@/lib/api/errors';
import { operationQuery } from '@/lib/api/queries';
import { useSetCrumb } from '@/lib/crumbs';
import { eventSentence } from '@/lib/events';
import { formatDuration, formatNumber } from '@/lib/format';
import { placeholderKeys } from '@/lib/placeholders';

export const Route = createFileRoute('/_authed/_workspace/p/$projectId/operations/$operationId')({
  validateSearch: z.object({ focus: z.string().optional(), ev: z.string().optional() }),
  staticData: { crumb: 'Operations' },
  loader: ({ context, params }) => {
    context.queryClient.prefetchQuery(operationQuery(params.projectId, params.operationId));
  },
  head: ({ params }) => ({ meta: [{ title: `Operation ${params.operationId} · Logbird` }] }),
  component: OperationPage,
});

interface Node {
  event: AuditEvent;
  depth: number;
  start: number;
  /** End of the span: the latest timestamp among the node and its descendants. */
  end: number;
  childCount: number;
  last: boolean;
  /** For each ancestor depth, whether a vertical guide continues below. */
  guides: boolean[];
}

/** Order events depth-first along parentEventId; orphans (parent outside the operation) become roots. */
function buildTree(events: AuditEvent[]): Node[] {
  const byId = new Map(events.map((e) => [e.id, e]));
  const children = new Map<string, AuditEvent[]>();
  const roots: AuditEvent[] = [];
  for (const e of events) {
    const parent = e.context.parentEventId;
    if (parent && byId.has(parent) && parent !== e.id) children.set(parent, [...(children.get(parent) ?? []), e]);
    else roots.push(e);
  }
  const ts = (e: AuditEvent) => Date.parse(e.timestamp);
  const endOf = new Map<string, number>();
  const spanEnd = (e: AuditEvent): number => {
    const cached = endOf.get(e.id);
    if (cached !== undefined) return cached;
    const end = Math.max(ts(e), ...(children.get(e.id) ?? []).map(spanEnd));
    endOf.set(e.id, end);
    return end;
  };
  const out: Node[] = [];
  const walk = (list: AuditEvent[], depth: number, guides: boolean[]) => {
    const sorted = [...list].sort((a, b) => ts(a) - ts(b));
    sorted.forEach((e, i) => {
      const last = i === sorted.length - 1;
      const kids = children.get(e.id) ?? [];
      out.push({ event: e, depth, start: ts(e), end: spanEnd(e), childCount: kids.length, last, guides });
      walk(kids, depth + 1, [...guides, !last]);
    });
  };
  walk(roots, 0, []);
  return out;
}

function OperationPage() {
  const { projectId, operationId } = Route.useParams();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const op = useQuery(operationQuery(projectId, operationId));
  useSetCrumb(operationId);
  const nodes = useMemo(() => buildTree(op.data ?? []), [op.data]);
  const t0 = nodes.length ? Math.min(...nodes.map((n) => n.start)) : 0;
  const t1 = nodes.length ? Math.max(...nodes.map((n) => n.end)) : 0;
  const total = Math.max(1, t1 - t0);
  const events = op.data ?? [];
  const failures = events.filter((e) => e.outcome === 'failure' || e.outcome === 'denied').length;
  const executors = [...new Map(events.filter((e) => e.executor?.id).map((e) => [e.executor?.id, e.executor])).values()];
  const actors = [...new Map(events.filter((e) => e.actor).map((e) => [e.actor?.id, e.actor])).values()];
  const selectedId = search.ev;
  const selectedIndex = nodes.findIndex((n) => n.event.id === selectedId);
  const highlight = search.focus;

  if (op.isError) {
    const notFound = op.error instanceof ApiRequestError && op.error.status === 404;
    return (
      <div className="p-6">
        {notFound ? (
          <EmptyState
            description="No stored event carries this operation id. It may be outside retention."
            icon={SearchXIcon}
            title="Operation not found"
          />
        ) : (
          <ErrorState error={op.error} onRetry={() => op.refetch()} />
        )}
      </div>
    );
  }

  // Instant operations (one event, or all at the same millisecond) get no time axis.
  const ticks = t1 - t0 > 0 ? [0, 0.25, 0.5, 0.75, 1] : [];

  return (
    <div className="flex flex-col gap-5 p-4 sm:p-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 flex-col gap-1">
          <span className="flex items-center gap-1.5 text-muted-foreground text-xs">
            <GitBranchIcon className="size-3.5" /> Operation
          </span>
          <h1 className="line-clamp-2 font-semibold text-xl tracking-tight" title={nodes[0] ? eventSentence(nodes[0].event) : undefined}>
            {nodes[0] ? eventSentence(nodes[0].event) : <Skeleton className="h-7 w-80" />}
          </h1>
          <CopyValue className="text-muted-foreground" value={operationId} />
        </div>
        <Button
          nativeButton={false}
          render={<Link params={{ projectId }} search={(prev) => ({ range: prev.range, q: `operation:${operationId}` })} to="/p/$projectId/events" />}
          size="sm"
          variant="outline"
        >
          <Rows3Icon />
          Open in explorer
        </Button>
      </div>

      <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border bg-border md:grid-cols-5 [&>div:last-child]:col-span-2 md:[&>div:last-child]:col-span-1">
        {[
          ['Events', op.data ? formatNumber(events.length) : ''],
          ['Duration', op.data ? formatDuration(t1 - t0) : ''],
          ['Problems', op.data ? formatNumber(failures) : ''],
          ['Started', nodes[0] ? <Timestamp iso={new Date(t0).toISOString()} key="started" /> : ''],
          ['Executors', op.data ? formatNumber(executors.length) : ''],
        ].map(([label, value]) => (
          <div className="flex flex-col gap-1 bg-card px-4 py-3" key={String(label)}>
            <dt className="text-muted-foreground text-xs">{label}</dt>
            <dd
              className={cn(
                'truncate font-semibold tabular-nums tracking-tight',
                'text-lg',
                label === 'Problems' && failures > 0 && 'text-outcome-failure',
              )}
            >
              {op.isPending ? <Skeleton className="h-7 w-16" /> : value}
            </dd>
          </div>
        ))}
      </dl>

      {actors.length > 0 || executors.length > 0 ? (
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-muted-foreground text-xs">Caused by</span>
            {actors
              .slice(0, 4)
              .map((a) => (a ? <EntityLink id={a.id} key={a.id} kind="actor" name={a.name} projectId={projectId} type={a.type} /> : null))}
          </span>
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-muted-foreground text-xs">Performed by</span>
            {executors.map((x) =>
              x ? <EntityLink id={x.id} key={x.id} kind="executor" meta={x.type} name={x.name} projectId={projectId} type={x.type} /> : null,
            )}
          </span>
        </div>
      ) : null}

      <section aria-label="Causation tree" className="overflow-hidden rounded-xl border bg-card shadow-xs">
        <div className="grid grid-cols-[minmax(0,1fr)] border-b bg-muted/30 text-[11px] text-muted-foreground uppercase tracking-wider md:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
          <span className="px-4 py-2">Event</span>
          <div className="relative hidden px-4 py-2 md:block">
            {ticks.map((t) => (
              <span
                className="absolute top-2 whitespace-nowrap font-mono text-[10px] normal-case tracking-normal"
                key={t}
                style={{
                  left: `calc(1rem + (100% - 2rem) * ${t})`,
                  transform: t === 1 ? 'translateX(-100%)' : t > 0 ? 'translateX(-50%)' : undefined,
                }}
              >
                {t === 0 ? '0' : `+${formatDuration(total * t)}`}
              </span>
            ))}
            &nbsp;
          </div>
        </div>
        {op.isPending ? (
          <div className="flex flex-col gap-1 p-3">
            {placeholderKeys(8).map((k, i) => (
              <Skeleton className="h-8" key={k} style={{ marginInlineStart: (i % 3) * 20 }} />
            ))}
          </div>
        ) : (
          <ul>
            {nodes.map((n) => {
              const e = n.event;
              const left = ((n.start - t0) / total) * 100;
              const width = Math.max(((n.end - n.start) / total) * 100, 0.6);
              const problem = e.outcome === 'failure' || e.outcome === 'denied';
              return (
                <li key={e.id}>
                  <button
                    className={cn(
                      'grid w-full grid-cols-[minmax(0,1fr)] items-center border-b border-border/60 text-start text-[13px] outline-none transition-colors last:border-b-0 hover:bg-muted/40 focus-visible:bg-muted/50 md:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]',
                      (e.id === selectedId || e.id === highlight) && 'bg-brand/[0.07]',
                    )}
                    onClick={() => navigate({ search: (prev) => ({ ...prev, ev: e.id }), replace: true })}
                    type="button"
                  >
                    <span className="flex min-w-0 items-center gap-2 py-2 pe-3 ps-4">
                      <span aria-hidden className="flex shrink-0 self-stretch">
                        {n.guides.map((g, i) => (
                          // biome-ignore lint/suspicious/noArrayIndexKey: guides are positional per depth
                          <span className={cn('w-4', g && 'border-border border-s')} key={i} />
                        ))}
                        {n.depth > 0 ? (
                          <span className={cn('relative w-4 border-border border-s', n.last && 'h-1/2')}>
                            <span className="absolute top-1/2 start-0 w-3 border-border border-t" />
                          </span>
                        ) : null}
                      </span>
                      <OutcomeDot outcome={e.outcome} />
                      <span className="flex min-w-0 flex-col">
                        <span className={cn('truncate', problem && 'font-medium')}>{eventSentence(e)}</span>
                        <span className="flex min-w-0 items-center gap-2 text-muted-foreground text-xs">
                          <ActionName action={e.action} className="text-[11px]" />
                          {e.executor?.id ? <span className="hidden shrink-0 font-mono text-[11px] sm:inline">{e.executor.id}</span> : null}
                          {e.executor && e.executor.attempt > 1 ? <TypePill tone="warning">attempt {e.executor.attempt}</TypePill> : null}
                        </span>
                      </span>
                    </span>
                    <span className="relative hidden h-full min-h-11 items-center px-4 md:flex">
                      <span className="absolute inset-y-0 start-4 end-4">
                        {ticks.slice(1, -1).map((t) => (
                          <span className="absolute inset-y-0 border-border/50 border-s border-dashed" key={t} style={{ left: `${t * 100}%` }} />
                        ))}
                      </span>
                      <span className="relative h-5 w-full">
                        <span
                          className={cn(
                            'absolute top-1/2 h-2.5 -translate-y-1/2 rounded-[3px]',
                            problem ? 'bg-outcome-failure/70' : n.childCount ? 'bg-brand/60' : 'bg-foreground/35',
                          )}
                          style={{ left: `${left}%`, width: `${width}%`, minWidth: 3 }}
                          title={`${formatDuration(n.start - t0)} after start · spans ${formatDuration(n.end - n.start)}`}
                        />
                        <span
                          className={cn(
                            'absolute top-1/2 -translate-y-1/2 whitespace-nowrap font-mono text-[10.5px]',
                            // Wide bars carry their label inside; others put it beside the bar, never over the tree.
                            left + width > 70 && left <= 25 ? 'start-1.5 rounded bg-background/85 px-1 text-foreground' : 'text-muted-foreground',
                          )}
                          style={
                            left + width > 70 ? (left > 25 ? { right: `${100 - left + 1}%` } : undefined) : { left: `calc(${left + width}% + 6px)` }
                          }
                        >
                          +{formatDuration(n.start - t0)}
                          {n.end > n.start ? ` · ${formatDuration(n.end - n.start)}` : ''}
                        </span>
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <EventSheet
        event={selectedIndex >= 0 ? (nodes[selectedIndex]?.event ?? null) : null}
        onNext={
          selectedIndex >= 0 && selectedIndex < nodes.length - 1
            ? () => navigate({ search: (prev) => ({ ...prev, ev: nodes[selectedIndex + 1]?.event.id }), replace: true })
            : undefined
        }
        onOpenChange={(open) => {
          if (!open) navigate({ search: (prev) => ({ ...prev, ev: undefined }), replace: true });
        }}
        onPrev={
          selectedIndex > 0 ? () => navigate({ search: (prev) => ({ ...prev, ev: nodes[selectedIndex - 1]?.event.id }), replace: true }) : undefined
        }
        open={Boolean(selectedId)}
        projectId={projectId}
      />
    </div>
  );
}
