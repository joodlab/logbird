import type { EntityKind, EntityProfile as Profile } from '@logbird/contracts';
import { outcomeColor, TypePill } from '@logbird/ui/components/badges';
import { CopyValue } from '@logbird/ui/components/copy-button';
import { EntityAvatar } from '@logbird/ui/components/entity-chip';
import { Panel } from '@logbird/ui/components/page-header';
import { EmptyState, ErrorState } from '@logbird/ui/components/states';
import { Button } from '@logbird/ui/components/ui/button';
import { Skeleton } from '@logbird/ui/components/ui/skeleton';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { ArrowLeftIcon, Rows3Icon, SearchXIcon, VenetianMaskIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { ActionName } from '@/components/action-name';
import { OutcomeAreaChart } from '@/components/charts/outcome-area-chart';
import { SupportSplitPanel, useSupportCounts, WhoSegmentedControl } from '@/components/entities/support-split';
import { EntityProfileLink } from '@/components/entity-link';
import { Explorer, type ExplorerState } from '@/components/explorer/explorer';
import { RankList } from '@/components/rank-list';
import { Timestamp } from '@/components/timestamp';
import { ApiRequestError } from '@/lib/api/errors';
import { entityProfileQuery } from '@/lib/api/queries';
import { useSetCrumb } from '@/lib/crumbs';
import { ENTITY_SECTIONS, type EntitySection, entityQuery, splitTargetId, typeIcon } from '@/lib/entities';
import { OUTCOME_ORDER } from '@/lib/events';
import { formatNumber } from '@/lib/format';
import { type WhoFilter, whoFilter, withWhoFilter } from '@/lib/impersonation';
import { formatTerm } from '@/lib/query-language';
import { rangeLabel } from '@/lib/range';
import { useDocumentTitle } from '@/lib/use-document-title';

const RELATED_LABEL: Record<EntityKind, string> = { actor: 'Actors', tenant: 'Tenants', executor: 'Executors', target: 'Records' };

interface EntityProfileProps {
  projectId: string;
  section: EntitySection;
  entityId: string;
  timeline: ExplorerState;
  onTimelineChange: (patch: Partial<ExplorerState>) => void;
}

export function EntityProfile({ projectId, section, entityId, timeline, onTimelineChange }: EntityProfileProps) {
  const meta = ENTITY_SECTIONS[section];
  const kind = meta.kind;
  const profile = useQuery(entityProfileQuery(projectId, kind, entityId, timeline.range));
  const navigate = useNavigate();
  const p = profile.data;
  const displayId = kind === 'target' ? splitTargetId(entityId).id : entityId;
  useSetCrumb(p?.entity.name || displayId);
  useDocumentTitle(`${p?.entity.name || displayId} · ${meta.singular} · Logbird`);
  const baseQuery = entityQuery(kind, entityId);
  const support = useSupportCounts(projectId, kind, entityId, baseQuery, timeline.range);
  const who = whoFilter(timeline.q);
  const onWho = (next: WhoFilter) => onTimelineChange({ q: withWhoFilter(timeline.q, next), ev: undefined });

  if (profile.isError && !p) {
    const notFound = profile.error instanceof ApiRequestError && profile.error.status === 404;
    return (
      <div className="p-6">
        {notFound ? (
          <EmptyState
            description={`No events mention ${displayId}. It may have been deleted by retention, or the id is mistyped.`}
            icon={SearchXIcon}
            title={`${meta.singular} not found`}
          >
            <Button
              nativeButton={false}
              render={<Link params={{ projectId }} to={`/p/$projectId/${section}` as '/p/$projectId/actors'} />}
              size="sm"
              variant="outline"
            >
              <ArrowLeftIcon />
              All {meta.label.toLowerCase()}
            </Button>
            {kind === 'actor' ? (
              <Button
                nativeButton={false}
                render={<Link params={{ projectId, agentId: entityId }} to="/p/$projectId/support/$agentId" />}
                size="sm"
                variant="outline"
              >
                <VenetianMaskIcon />
                Look for {displayId} as a support agent
              </Button>
            ) : null}
          </EmptyState>
        ) : (
          <ErrorState error={profile.error} onRetry={() => profile.refetch()} />
        )}
      </div>
    );
  }

  const showIcon = !(kind === 'actor' && (p?.entity.type === 'user' || p?.entity.type === 'anonymous'));
  const outcomes = p ? Object.entries(p.outcomes) : [];
  const outcomeTotal = outcomes.reduce((s, [, n]) => s + n, 0);
  const sortedOutcomes = [...outcomes].sort(
    ([a], [b]) => (OUTCOME_ORDER as readonly string[]).indexOf(a) - (OUTCOME_ORDER as readonly string[]).indexOf(b),
  );

  return (
    <div className="flex flex-col">
      <div className="flex flex-col gap-5 p-4 sm:p-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex min-w-0 items-center gap-4">
            {p ? (
              <EntityAvatar
                icon={showIcon ? typeIcon(kind, p.entity.type) : undefined}
                id={entityId}
                name={p.entity.name || displayId}
                size="lg"
                square={kind !== 'actor'}
              />
            ) : (
              <Skeleton className="size-11 rounded-full" />
            )}
            <div className="flex min-w-0 flex-col gap-1">
              <div className="flex items-center gap-2 text-muted-foreground text-xs">
                <Link className="hover:text-foreground" params={{ projectId }} to={`/p/$projectId/${section}` as '/p/$projectId/actors'}>
                  {meta.singular}
                </Link>
                {p?.entity.type ? <TypePill>{p.entity.type}</TypePill> : null}
              </div>
              <h1 className="truncate font-semibold text-xl tracking-tight" dir="auto">
                {p ? p.entity.name || displayId : <Skeleton className="h-6 w-48" />}
              </h1>
              <CopyValue className="text-muted-foreground" value={displayId} />
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button
              nativeButton={false}
              render={<Link params={{ projectId }} search={(prev) => ({ range: prev.range, q: baseQuery })} to="/p/$projectId/events" />}
              size="sm"
              variant="outline"
            >
              <Rows3Icon />
              Open in explorer
            </Button>
          </div>
        </div>

        <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border bg-border sm:grid-cols-4">
          <Stat label={`Events · ${rangeLabel(timeline.range).toLowerCase()}`} loading={!p} value={p ? formatNumber(outcomeTotal) : ''} />
          <Stat label="Events · all time" loading={!p} value={p ? formatNumber(p.entity.events) : ''} />
          <Stat label="First seen" loading={!p} value={p ? <Timestamp format="date" iso={p.entity.firstSeen} /> : ''} />
          <Stat label="Last seen" loading={!p} value={p ? <Timestamp format="relative" iso={p.entity.lastSeen} /> : ''} />
        </dl>

        <SupportSplitPanel
          counts={support}
          entityId={entityId}
          kind={kind}
          name={p?.entity.name || displayId}
          onWho={onWho}
          projectId={projectId}
          total={p ? outcomeTotal : undefined}
          who={who}
        />

        <div className="grid gap-3 lg:grid-cols-[1fr_320px]">
          <Panel description="Click a band to filter the timeline below" title="Activity">
            <div className="p-3 pb-2">
              {p ? (
                <OutcomeAreaChart
                  data={p.series}
                  height={236}
                  onSelectOutcome={(o) => onTimelineChange({ q: formatTerm('outcome', o), ev: undefined })}
                />
              ) : (
                <Skeleton className="h-[244px] w-full" />
              )}
            </div>
          </Panel>
          <div className="flex flex-col gap-3">
            <Panel title="Outcomes">
              <div className="flex flex-col gap-3 p-4">
                {p ? (
                  outcomeTotal === 0 ? (
                    <p className="text-muted-foreground text-sm">No events in this range.</p>
                  ) : (
                    <>
                      <div className="flex h-2 overflow-hidden rounded-full bg-muted">
                        {sortedOutcomes.map(([o, n]) => (
                          <span key={o} style={{ width: `${(n / outcomeTotal) * 100}%`, background: outcomeColor(o) }} title={`${o}: ${n}`} />
                        ))}
                      </div>
                      <ul className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-[13px]">
                        {sortedOutcomes.map(([o, n]) => (
                          <li key={o}>
                            <button
                              className="flex w-full items-center justify-between gap-2 rounded-sm text-start hover:text-foreground"
                              onClick={() => onTimelineChange({ q: formatTerm('outcome', o), ev: undefined })}
                              type="button"
                            >
                              <span className="flex items-center gap-1.5 text-muted-foreground">
                                <span className="size-2 rounded-full" style={{ background: outcomeColor(o) }} />
                                {o}
                              </span>
                              <span className="tabular-nums">{formatNumber(n)}</span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    </>
                  )
                ) : (
                  <Skeleton className="h-16 w-full" />
                )}
              </div>
            </Panel>
            <Panel title="Top actions">
              <RankList
                items={(p?.topActions ?? []).slice(0, 5).map((a) => ({
                  key: a.id,
                  label: <ActionName action={a.id} />,
                  count: a.count,
                  render: (children, className) => (
                    <button className={className} onClick={() => onTimelineChange({ q: formatTerm('action', a.id), ev: undefined })} type="button">
                      {children}
                    </button>
                  ),
                }))}
                loading={!p}
                rows={5}
              />
            </Panel>
          </div>
        </div>

        {p && p.related.length > 0 ? <Related projectId={projectId} related={p.related} /> : null}
      </div>

      <section aria-label="Timeline" className="flex flex-col border-t">
        <div className="flex flex-wrap items-center justify-between gap-2 px-4 pt-4 sm:px-6">
          <h2 className="font-medium text-sm">Timeline</h2>
          {(support?.support ?? 0) > 0 || who !== 'all' ? <WhoSegmentedControl kind={kind} onWho={onWho} who={who} /> : null}
          <button
            className="text-muted-foreground text-xs hover:text-foreground"
            onClick={() =>
              navigate({
                to: '/p/$projectId/events',
                params: { projectId },
                search: (prev) => ({ range: prev.range, q: [baseQuery, timeline.q].filter(Boolean).join(' ') }),
              })
            }
            type="button"
          >
            Open full explorer →
          </button>
        </div>
        <div className="flex h-[640px] min-h-0 flex-col">
          <Explorer
            baseLabel={`${kind}: ${p?.entity.name || displayId}`}
            baseQuery={baseQuery}
            embedded
            onChange={onTimelineChange}
            projectId={projectId}
            state={timeline}
          />
        </div>
      </section>
    </div>
  );
}

function Stat({ label, value, loading }: { label: string; value: ReactNode; loading: boolean }) {
  return (
    <div className="flex flex-col gap-1 bg-card px-4 py-3">
      <dt className="truncate text-muted-foreground text-xs">{label}</dt>
      <dd className="font-semibold text-lg tabular-nums tracking-tight">{loading ? <Skeleton className="h-6 w-16" /> : value}</dd>
    </div>
  );
}

function Related({ projectId, related }: { projectId: string; related: Profile['related'] }) {
  const groups = new Map<EntityKind, Profile['related']>();
  for (const r of related) groups.set(r.kind, [...(groups.get(r.kind) ?? []), r]);
  return (
    <Panel description="Entities that appear in the same events" title="Related">
      <div className="grid divide-y sm:grid-cols-[repeat(auto-fit,minmax(220px,1fr))] sm:divide-x sm:divide-y-0">
        {[...groups.entries()].map(([kind, items]) => (
          <div className="flex flex-col gap-1 p-3" key={kind}>
            <span className="px-1 pb-1 text-[11px] text-muted-foreground uppercase tracking-wider">{RELATED_LABEL[kind]}</span>
            {items.map((r) => {
              const showIcon = !(kind === 'actor' && (r.type === 'user' || r.type === 'anonymous'));
              return (
                <EntityProfileLink
                  className="flex min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-[13px] outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring/50"
                  id={r.id}
                  key={`${r.kind}:${r.id}`}
                  kind={r.kind}
                  projectId={projectId}
                >
                  <EntityAvatar
                    icon={showIcon ? typeIcon(r.kind, r.type) : undefined}
                    id={r.id}
                    name={r.name || r.id}
                    size="sm"
                    square={r.kind !== 'actor'}
                  />
                  <span className="min-w-0 flex-1 truncate" dir="auto">
                    {r.name || r.id}
                  </span>
                  {r.type ? <span className="hidden font-mono text-[11px] text-muted-foreground sm:inline">{r.type}</span> : null}
                  <span className="text-muted-foreground text-xs tabular-nums">{formatNumber(r.count)}</span>
                </EntityProfileLink>
              );
            })}
          </div>
        ))}
      </div>
    </Panel>
  );
}
