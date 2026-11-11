import type { AuditEvent } from '@logbird/contracts';
import { OutcomeDot, SeverityBadge } from '@logbird/ui/components/badges';
import { EntityChip } from '@logbird/ui/components/entity-chip';
import { Panel } from '@logbird/ui/components/page-header';
import { Sparkline } from '@logbird/ui/components/sparkline';
import { StatCard } from '@logbird/ui/components/stat-card';
import { EmptyState, ErrorState } from '@logbird/ui/components/states';
import { Button } from '@logbird/ui/components/ui/button';
import { Skeleton } from '@logbird/ui/components/ui/skeleton';
import { useQuery } from '@tanstack/react-query';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { ArrowRightIcon, CheckCircle2Icon, RadioIcon, Rows3Icon } from 'lucide-react';
import { ActionName } from '@/components/action-name';
import { OutcomeAreaChart } from '@/components/charts/outcome-area-chart';
import { EntityProfileLink } from '@/components/entity-link';
import { RankList } from '@/components/rank-list';
import { SampleDataBanner } from '@/components/setup/sample-data-banner';
import { SetupChecklistCard } from '@/components/setup/setup-checklist-card';
import { Timestamp } from '@/components/timestamp';
import { overviewQuery, projectQuery, projectSetupQuery } from '@/lib/api/queries';
import { eventSentence } from '@/lib/events';
import { delta, formatNumber, formatPercent } from '@/lib/format';
import { placeholderKeys } from '@/lib/placeholders';
import { DEFAULT_RANGE, isValidRange, rangeLabel } from '@/lib/range';
import { useRange } from '@/lib/use-range';

export const Route = createFileRoute('/_authed/_workspace/p/$projectId/')({
  head: () => ({ meta: [{ title: 'Overview · Logbird' }] }),
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
  // The setup checklist scores real events only; say so here while sample data is mixed into this average.
  const setup = useQuery(projectSetupQuery(projectId));
  const hasSampleData = (setup.data?.ingest.sampleEvents ?? 0) > 0;
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

      <SampleDataBanner className="rounded-lg border" projectId={projectId} />
      <SetupChecklistCard projectId={projectId} projectName={project.data?.name} />

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
          delta={k ? k.failureRate - k.failureRatePrev : undefined}
          deltaKind="points"
          goodWhen="down"
          hint="failure + denied"
          label="Failure rate"
          loading={loading}
          onClick={() => explore('(outcome:failure OR outcome:denied)')}
          value={k ? formatPercent(k.failureRate) : '—'}
        />
        <StatCard
          className="col-span-2 md:col-span-1"
          footer={
            // The empty track shows while loading, so the card (and the row of cards) keeps its height.
            <div className="h-1.5 overflow-hidden rounded-full bg-muted">
              <div className="h-full rounded-full bg-brand transition-[width]" style={{ width: `${k ? Math.round(k.avgConformance) : 0}%` }} />
            </div>
          }
          hint={hasSampleData ? 'in range · includes sample data' : undefined}
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
              // The chart (240 px), the gap and the one-row legend below it.
              <Skeleton className="h-[276px] w-full" />
            ) : (
              <OutcomeAreaChart data={data?.series} height={240} onSelectOutcome={(o) => explore(`outcome:${o}`)} />
            )}
          </div>
        </Panel>
        <Panel title="Ingestion">
          <div className="flex flex-col gap-4 p-4">
            {loading ? (
              // Status line, the two figures, the sparkline and the button.
              <Skeleton className="h-[216px] w-full" />
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
                    <dd className="font-medium">
                      <Timestamp fallback="never" format="relative" iso={data?.ingest.lastEventAt} />
                    </dd>
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
        <Panel title="Top executors">
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
          <span className="truncate text-sm" dir="auto">
            {eventSentence(event)}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-3 ps-4.5 sm:ps-0">
          <SeverityBadge hideInfo severity={event.severity} />
          <ActionName action={event.action} className="hidden max-w-56 md:inline" />
          {event.actor ? (
            <span className="hidden max-w-44 lg:inline-flex">
              <EntityChip id={event.actor.id} name={event.actor.name} />
            </span>
          ) : null}
          <Timestamp className="w-24 shrink-0 text-end text-muted-foreground text-xs" iso={event.timestamp} />
        </span>
      </Link>
    </li>
  );
}
