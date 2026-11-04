import { useQuery } from '@tanstack/react-query';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import type { AuditEvent } from '@trailmark/contracts';
import { OutcomeDot, SeverityBadge } from '@trailmark/ui/components/badges';
import { EntityChip } from '@trailmark/ui/components/entity-chip';
import { Panel } from '@trailmark/ui/components/page-header';
import { Sparkline } from '@trailmark/ui/components/sparkline';
import { StatCard } from '@trailmark/ui/components/stat-card';
import { EmptyState, ErrorState } from '@trailmark/ui/components/states';
import { Button } from '@trailmark/ui/components/ui/button';
import { Skeleton } from '@trailmark/ui/components/ui/skeleton';
import { ArrowRightIcon, CheckCircle2Icon, RadioIcon, Rows3Icon, SendIcon } from 'lucide-react';
import { ActionName } from '@/components/action-name';
import { OutcomeAreaChart } from '@/components/charts/outcome-area-chart';
import { EntityProfileLink } from '@/components/entity-link';
import { RankList } from '@/components/rank-list';
import { overviewQuery, projectQuery } from '@/lib/api/queries';
import { eventSentence } from '@/lib/events';
import { delta, formatNumber, formatPercent, formatRelative, formatTimestamp } from '@/lib/format';
import { placeholderKeys } from '@/lib/placeholders';
import { DEFAULT_RANGE, isValidRange, rangeLabel } from '@/lib/range';
import { useRange } from '@/lib/use-range';

export const Route = createFileRoute('/_authed/_workspace/p/$projectId/')({
  staticData: { crumb: 'Overview', range: true },
  loaderDeps: ({ search }) => ({ range: search.range }),
  loader: ({ context, params, deps }) => {
    const range = deps.range && isValidRange(deps.range) ? deps.range : DEFAULT_RANGE;
    context.queryClient.prefetchQuery(overviewQuery(params.projectId, range));
  },
  component: OverviewPage,
});

function OverviewPage() {
  const { projectId } = Route.useParams();
  const { range } = useRange();
  const navigate = useNavigate();
  const project = useQuery(projectQuery(projectId));
  const overview = useQuery(overviewQuery(projectId, range));
  const data = overview.data;
  const loading = overview.isPending;
  const k = data?.kpis;
  const explore = (q: string) => navigate({ to: '/p/$projectId/events', params: { projectId }, search: (prev) => ({ range: prev.range, q }) });

  if (overview.isError && !data) {
    return (
      <div className="p-6">
        <ErrorState error={overview.error} onRetry={() => overview.refetch()} title="Could not load the overview" />
      </div>
    );
  }

  const neverReceived = project.data && !project.data.lastEventAt;

  return (
    <div className="flex flex-col gap-5 p-4 sm:p-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex min-w-0 flex-col gap-1">
          <h1 className="font-semibold text-xl tracking-tight">Overview</h1>
          <p className="text-muted-foreground text-sm">
            {rangeLabel(range)} · {project.data?.description || 'Who did what, to which record, and how it went.'}
          </p>
        </div>
        <Button
          nativeButton={false}
          render={<Link params={{ projectId }} search={(prev) => ({ range: prev.range })} to="/p/$projectId/events" />}
          size="sm"
          variant="outline"
        >
          <Rows3Icon />
          Open explorer
        </Button>
      </div>

      {neverReceived ? (
        <div className="flex flex-col gap-3 rounded-xl border border-dashed bg-card p-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <SendIcon className="mt-0.5 size-5 text-brand" />
            <div className="flex flex-col gap-0.5">
              <p className="font-medium text-sm">No events yet</p>
              <p className="text-muted-foreground text-sm">
                Send your first event with the SDK or a single curl. The dashboard fills in within seconds.
              </p>
            </div>
          </div>
          <Button nativeButton={false} render={<Link params={{ projectId }} to="/onboarding/first-event/$projectId" />} size="sm">
            Send first event
            <ArrowRightIcon />
          </Button>
        </div>
      ) : null}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        <StatCard
          delta={k ? delta(k.events, k.eventsPrev) : undefined}
          label="Events"
          loading={loading}
          onClick={() => explore('')}
          value={k ? formatNumber(k.events) : '—'}
        />
        <StatCard
          delta={k ? delta(k.actors, k.actorsPrev) : undefined}
          label="Active actors"
          loading={loading}
          onClick={() => navigate({ to: '/p/$projectId/actors', params: { projectId } })}
          value={k ? formatNumber(k.actors) : '—'}
        />
        <StatCard
          label="Tenants"
          loading={loading}
          onClick={() => navigate({ to: '/p/$projectId/tenants', params: { projectId } })}
          value={k ? formatNumber(k.tenants) : '—'}
        />
        <StatCard
          delta={k ? (k.failureRatePrev ? (k.failureRate - k.failureRatePrev) / k.failureRatePrev : null) : undefined}
          goodWhen="down"
          hint="failure + denied"
          label="Failure rate"
          loading={loading}
          onClick={() => explore('-outcome:success -outcome:partial')}
          value={k ? formatPercent(k.failureRate) : '—'}
        />
        <StatCard
          className="col-span-2 md:col-span-1"
          footer={
            k ? (
              <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                <div className="h-full rounded-full bg-brand transition-[width]" style={{ width: `${Math.round(k.avgConformance)}%` }} />
              </div>
            ) : null
          }
          label="Avg conformance"
          loading={loading}
          onClick={() => navigate({ to: '/p/$projectId/fields', params: { projectId } })}
          value={k ? `${Math.round(k.avgConformance)}%` : '—'}
        />
      </div>

      <div className="grid gap-3 xl:grid-cols-[1fr_300px]">
        <Panel description="Click a band to open those events" title="Events by outcome">
          <div className="p-3 pb-2">
            {loading ? (
              <Skeleton className="h-[248px] w-full" />
            ) : (
              <OutcomeAreaChart data={data?.series} height={240} onSelectOutcome={(o) => explore(`outcome:${o}`)} />
            )}
          </div>
        </Panel>
        <Panel title="Ingestion">
          <div className="flex flex-col gap-4 p-4">
            {loading ? (
              <Skeleton className="h-40 w-full" />
            ) : (
              <>
                <div className="flex items-center gap-2">
                  {data?.ingest.lastEventAt && Date.now() - Date.parse(data.ingest.lastEventAt) < 5 * 60_000 ? (
                    <>
                      <span className="tm-pulse-dot size-2 rounded-full bg-outcome-success text-outcome-success" />
                      <span className="font-medium text-sm">Receiving events</span>
                    </>
                  ) : (
                    <>
                      <span className="size-2 rounded-full bg-outcome-unknown" />
                      <span className="font-medium text-sm">Quiet</span>
                    </>
                  )}
                </div>
                <dl className="grid grid-cols-2 gap-3 text-sm">
                  <div className="flex flex-col gap-0.5">
                    <dt className="text-muted-foreground text-xs">Last event</dt>
                    <dd className="font-medium tabular-nums">{formatRelative(data?.ingest.lastEventAt)}</dd>
                  </div>
                  <div className="flex flex-col gap-0.5">
                    <dt className="text-muted-foreground text-xs">Last hour</dt>
                    <dd className="font-medium tabular-nums">{formatNumber(data?.ingest.eventsLastHour ?? 0)}</dd>
                  </div>
                </dl>
                <div className="flex flex-col gap-1.5">
                  <div className="flex items-center justify-between text-muted-foreground text-xs">
                    <span className="flex items-center gap-1">
                      <RadioIcon className="size-3" /> Events / minute
                    </span>
                    <span>60 min</span>
                  </div>
                  <Sparkline height={56} values={data?.ingest.perMinute.map((p) => p.count) ?? []} />
                </div>
                <Button
                  nativeButton={false}
                  render={<Link params={{ projectId }} search={{ live: true }} to="/p/$projectId/events" />}
                  size="sm"
                  variant="outline"
                >
                  Open live tail
                </Button>
              </>
            )}
          </div>
        </Panel>
      </div>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <Panel title="Top actions">
          <RankList
            items={(data?.topActions ?? []).map((a) => ({
              key: a.id,
              label: <ActionName action={a.id} />,
              count: a.count,
              render: (children, className) => (
                <button className={className} onClick={() => explore(`action:${a.id}`)} type="button">
                  {children}
                </button>
              ),
            }))}
            loading={loading}
          />
        </Panel>
        <Panel title="Top actors">
          <RankList
            items={(data?.topActors ?? []).map((a) => ({
              key: a.id,
              label: <span className="truncate">{a.label}</span>,
              count: a.count,
              render: (children, className) => (
                <EntityProfileLink className={className} id={a.id} kind="actor" projectId={projectId}>
                  {children}
                </EntityProfileLink>
              ),
            }))}
            loading={loading}
          />
        </Panel>
        <Panel title="Top tenants">
          <RankList
            items={(data?.topTenants ?? []).map((a) => ({
              key: a.id,
              label: <span className="truncate">{a.label}</span>,
              count: a.count,
              render: (children, className) => (
                <EntityProfileLink className={className} id={a.id} kind="tenant" projectId={projectId}>
                  {children}
                </EntityProfileLink>
              ),
            }))}
            loading={loading}
          />
        </Panel>
        <Panel title="Top workers">
          <RankList
            items={(data?.topExecutors ?? []).map((a) => ({
              key: a.id,
              label: (
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="truncate">{a.label}</span>
                  <span className="font-mono text-[11px] text-muted-foreground">{a.type}</span>
                </span>
              ),
              count: a.count,
              render: (children, className) => (
                <EntityProfileLink className={className} id={a.id} kind="executor" projectId={projectId}>
                  {children}
                </EntityProfileLink>
              ),
            }))}
            loading={loading}
          />
        </Panel>
      </div>

      <Panel
        actions={
          <Button
            nativeButton={false}
            render={
              <Link
                params={{ projectId }}
                search={(prev) => ({ range: prev.range, q: '-outcome:success -outcome:partial' })}
                to="/p/$projectId/events"
              />
            }
            size="xs"
            variant="ghost"
          >
            View all
            <ArrowRightIcon />
          </Button>
        }
        description="Latest failures, denials and critical events"
        title="Recent problems"
      >
        {loading ? (
          <div className="flex flex-col gap-2 p-3">
            {placeholderKeys(4).map((k) => (
              <Skeleton className="h-10 w-full" key={k} />
            ))}
          </div>
        ) : (data?.recentProblems.length ?? 0) === 0 ? (
          <EmptyState description="No failures, denials or critical events in this range." icon={CheckCircle2Icon} size="sm" title="All clear" />
        ) : (
          <ul className="divide-y">
            {data?.recentProblems.map((e) => (
              <ProblemRow event={e} key={e.id} projectId={projectId} />
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}

function ProblemRow({ event, projectId }: { event: AuditEvent; projectId: string }) {
  return (
    <li>
      <Link
        className="flex flex-col gap-1 px-4 py-2.5 outline-none transition-colors hover:bg-muted/50 focus-visible:bg-muted/50 sm:flex-row sm:items-center sm:gap-3"
        params={{ projectId }}
        search={(prev) => ({ range: prev.range, ev: event.id, q: `id:${event.id}` })}
        to="/p/$projectId/events"
      >
        <span className="flex min-w-0 flex-1 items-center gap-2.5">
          <OutcomeDot outcome={event.outcome} />
          <span className="truncate text-sm">{eventSentence(event)}</span>
        </span>
        <span className="flex shrink-0 items-center gap-3 ps-4.5 sm:ps-0">
          <SeverityBadge hideInfo severity={event.severity} />
          <ActionName action={event.action} className="hidden max-w-56 md:inline" />
          {event.actor ? (
            <span className="hidden max-w-44 lg:inline-flex">
              <EntityChip id={event.actor.id} name={event.actor.name} />
            </span>
          ) : null}
          <span className="w-24 text-end text-muted-foreground text-xs tabular-nums">{formatTimestamp(event.timestamp)}</span>
        </span>
      </Link>
    </li>
  );
}
