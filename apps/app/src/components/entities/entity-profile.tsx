import type { EntityKind, EntityProfile as Profile } from '@logbird/contracts';
import { outcomeColor, TypePill } from '@logbird/ui/components/badges';
import { CopyValue } from '@logbird/ui/components/copy-button';
import { EntityAvatar } from '@logbird/ui/components/entity-chip';
import { Panel } from '@logbird/ui/components/page-header';
import { StatTile, StatTileGrid } from '@logbird/ui/components/stat-card';
import { EmptyState, ErrorState } from '@logbird/ui/components/states';
import { Button } from '@logbird/ui/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@logbird/ui/components/ui/popover';
import { Skeleton } from '@logbird/ui/components/ui/skeleton';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { ArrowLeftIcon, BookmarkIcon, InfoIcon, Rows3Icon, SearchXIcon, VenetianMaskIcon } from 'lucide-react';
import { ActionName } from '@/components/action-name';
import { OutcomeAreaChart } from '@/components/charts/outcome-area-chart';
import { SupportSplitPanel, useSupportCounts, WhoSegmentedControl } from '@/components/entities/support-split';
import { EntityProfileLink } from '@/components/entity-link';
import { Explorer, type ExplorerState } from '@/components/explorer/explorer';
import { RankList } from '@/components/rank-list';
import { Timestamp } from '@/components/timestamp';
import { SaveEntityViewButton } from '@/components/views/save-entity-view-button';
import { current } from '@/lib/api/current';
import { ApiRequestError } from '@/lib/api/errors';
import { entityProfileQuery, entitySeenQuery } from '@/lib/api/queries';
import { useSetCrumb } from '@/lib/crumbs';
import { countsMentions, ENTITY_SECTIONS, type EntitySection, entityBaseQuery, splitTargetId, typeIcon } from '@/lib/entities';
import { OUTCOME_ORDER } from '@/lib/events';
import { formatNumber } from '@/lib/format';
import { type WhoFilter, whoFilter, withWhoFilter } from '@/lib/impersonation';
import { outcomeBandQuery } from '@/lib/overview-queries';
import { formatTerm, scopedQuery } from '@/lib/query-language';
import { ALL_RANGE, historyRange, rangeInSentence, rangeLabel } from '@/lib/range';
import { useConsoleZone } from '@/lib/time-zone';
import { useDocumentTitle } from '@/lib/use-document-title';
import { useRange } from '@/lib/use-range';

const RELATED_LABEL: Record<EntityKind, string> = { actor: 'Actors', tenant: 'Tenants', executor: 'Executors', target: 'Records' };

interface EntityProfileProps {
  projectId: string;
  section: EntitySection;
  entityId: string;
  targetType?: string;
  timeline: ExplorerState;
  onTimelineChange: (patch: Partial<ExplorerState>) => void;
}

export function EntityProfile({ projectId, section, entityId, targetType, timeline, onTimelineChange }: EntityProfileProps) {
  useConsoleZone(); // Range labels and times read the console zone: re-render when the reader switches it.
  const meta = ENTITY_SECTIONS[section];
  const kind = meta.kind;
  const profile = useQuery(entityProfileQuery(projectId, kind, entityId, timeline.range, targetType));
  const navigate = useNavigate();
  // Never another entity's or range's numbers under this URL: a placeholder (the previous query's result) renders as
  // loading, so the name, stats, charts and related lists always belong to this entity and this range.
  const p = current(profile);
  const displayId = kind === 'target' ? splitTargetId(entityId, targetType ?? p?.entity.type).id : entityId;
  useSetCrumb(p?.entity.name || displayId);
  useDocumentTitle(`${p?.entity.name || displayId} · ${meta.singular} · Logbird`);
  const baseQuery = entityBaseQuery(kind, entityId, targetType, p?.entity.type);
  const support = useSupportCounts(projectId, kind, entityId, baseQuery, timeline.range);
  const lang = timeline.lang ?? 'query';
  const who = whoFilter(timeline.q, lang);
  const onWho = (next: WhoFilter) => onTimelineChange({ q: withWhoFilter(timeline.q, next, lang), ev: undefined });
  // The history shows everything this entity did unless the reader picked a range; the charts follow the picker.
  const { explicit: rangeChosen, clearRange } = useRange();
  // Only this entity's own data may define its history (a placeholder can still hold the previous entity's). The window
  // comes from the directory's first and last seen, a quick read, so the history never waits for the whole profile; the
  // profile is the fallback when the directory does not list this id. One source per page load, so the window never
  // switches (and refetches) when the profile arrives.
  const own = p;
  const seen = useQuery({ ...entitySeenQuery(projectId, kind, entityId), enabled: !rangeChosen });
  const seenWindow = seen.data ?? (seen.isSuccess || seen.isError ? (own?.entity ?? null) : null);
  const timelineRange = rangeChosen ? timeline.range : seenWindow ? historyRange(seenWindow.firstSeen, Date.now(), seenWindow.lastSeen) : undefined;
  // Out of a full history, links say "all" rather than this entity's computed window, so the next page is not narrowed.
  const linkRange = rangeChosen ? timeline.range : ALL_RANGE;
  // What History shows (the entity plus any filters typed or picked there): the explorer links and Save as view use it.
  // Null while the typed filter does not parse: nothing is combined, saved or opened then (scopedQuery).
  // Also null until the entity's own filter is known (a record's type arrives with its profile): no history, link or
  // saved view may ever run without it, whatever range is chosen.
  const historyQuery = baseQuery ? scopedQuery(baseQuery, timeline.q).q : null;

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
              {/* min-h-5: the type pill's height, so the header does not grow when the profile (and its type) arrives. */}
              <div className="flex min-h-5 items-center gap-2 text-muted-foreground text-xs">
                <Link className="hover:text-foreground" params={{ projectId }} to={`/p/$projectId/${section}` as '/p/$projectId/actors'}>
                  {meta.singular}
                </Link>
                {p?.entity.type ? <TypePill>{p.entity.type}</TypePill> : null}
              </div>
              <h1 className="truncate font-semibold text-xl tracking-tight" dir="auto">
                {p ? p.entity.name || displayId : <Skeleton className="h-7 w-48" />}
              </h1>
              <CopyValue className="text-muted-foreground" value={displayId} />
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {timelineRange && own && historyQuery !== null ? (
              <>
                <SaveEntityViewButton
                  displayId={displayId}
                  name={own.entity.name || displayId}
                  projectId={projectId}
                  query={historyQuery}
                  // The scope the reader sees: "all" for an implicit full history, so the view never shrinks.
                  range={linkRange}
                />
                <Button
                  nativeButton={false}
                  render={<Link params={{ projectId }} search={{ range: linkRange, q: historyQuery }} to="/p/$projectId/events" />}
                  size="sm"
                  variant="outline"
                >
                  <Rows3Icon />
                  Open in explorer
                </Button>
              </>
            ) : (
              // Until the history's range is known, or while the typed filter does not parse, neither action could say
              // what it saves or opens.
              <>
                <Button disabled size="sm" variant="outline">
                  <BookmarkIcon />
                  Save as view
                </Button>
                <Button disabled size="sm" variant="outline">
                  <Rows3Icon />
                  Open in explorer
                </Button>
              </>
            )}
          </div>
        </div>

        <StatTileGrid className="grid-cols-2 sm:grid-cols-4">
          <StatTile label={`Events · ${rangeInSentence(rangeLabel(timeline.range))}`} loading={!p} value={p ? formatNumber(outcomeTotal) : ''} />
          <StatTile
            label={
              countsMentions(kind, entityId) ? (
                // For a record whose id has one colon the server reads the rollup, which counts each time an event names
                // the record (twice if it lists it twice). With more colons it counts the events themselves.
                <span className="inline-flex items-center gap-1">
                  Mentions · all time
                  {/* A popover, not a tooltip: it opens by click, tap or keyboard, so every reader can get the explanation. */}
                  <Popover>
                    <PopoverTrigger
                      render={
                        <button
                          aria-label="About this count"
                          className="rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
                          type="button"
                        />
                      }
                    >
                      <InfoIcon className="size-3" />
                    </PopoverTrigger>
                    <PopoverContent className="w-64 p-3 text-sm">
                      How many times events named this record. An event that lists it twice counts twice.
                    </PopoverContent>
                  </Popover>
                </span>
              ) : (
                'Events · all time'
              )
            }
            loading={!p}
            value={p ? formatNumber(p.entity.events) : ''}
          />
          <StatTile label="First seen" loading={!p} value={p ? <Timestamp format="date" iso={p.entity.firstSeen} /> : ''} />
          <StatTile label="Last seen" loading={!p} value={p ? <Timestamp format="relative" iso={p.entity.lastSeen} /> : ''} />
        </StatTileGrid>

        <SupportSplitPanel
          counts={support}
          entityId={entityId}
          kind={kind}
          name={p?.entity.name || displayId}
          projectId={projectId}
          total={p ? outcomeTotal : undefined}
        />

        <section aria-labelledby="entity-history" className="flex flex-col overflow-hidden rounded-xl border bg-card shadow-xs">
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b px-4 py-3">
            <div className="flex min-w-0 flex-col gap-0.5">
              <h2 className="font-medium text-sm" id="entity-history">
                History
              </h2>
              <div className="min-h-4 text-muted-foreground text-xs">
                {rangeChosen ? (
                  <>
                    {rangeLabel(timeline.range)}, from the time range above ·{' '}
                    <button className="font-medium text-foreground underline-offset-2 hover:underline" onClick={clearRange} type="button">
                      Clear time range
                    </button>
                  </>
                ) : !own ? (
                  <Skeleton className="h-4 w-56" />
                ) : kind === 'target' ? (
                  // The history matches this record's type and id at the same position (`record:`), but the all-time count
                  // comes from the colon-joined rollup key, which another type can share: no exact count is claimed here.
                  <>
                    Every event for this record since <Timestamp format="date" iso={own.entity.firstSeen} />, newest first
                  </>
                ) : (
                  <>
                    All {formatNumber(own.entity.events)} event{own.entity.events === 1 ? '' : 's'} since{' '}
                    <Timestamp format="date" iso={own.entity.firstSeen} />, newest first
                  </>
                )}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              {/* The history spans more than the charts' range: offer the support filter whatever the charts counted. */}
              <WhoSegmentedControl kind={kind} onWho={onWho} who={who} />
              <button
                className="text-muted-foreground text-xs hover:text-foreground disabled:opacity-50"
                disabled={!timelineRange || historyQuery === null}
                onClick={() =>
                  timelineRange && historyQuery !== null
                    ? navigate({
                        to: '/p/$projectId/events',
                        params: { projectId },
                        search: { range: linkRange, q: historyQuery },
                      })
                    : undefined
                }
                type="button"
              >
                Open in the explorer →
              </button>
            </div>
          </div>
          <div className="flex h-[600px] min-h-0 flex-col">
            {timelineRange && baseQuery ? (
              <Explorer
                baseLabel={`${kind}: ${p?.entity.name || displayId}`}
                baseQuery={baseQuery}
                embedded
                onChange={onTimelineChange}
                projectId={projectId}
                rangeComplete={!rangeChosen}
                rangeLabel={rangeChosen ? undefined : 'All history'}
                state={{ ...timeline, range: timelineRange }}
              />
            ) : (
              <div className="flex flex-col gap-2 p-4">
                <Skeleton className="h-9 w-full" />
                <Skeleton className="h-24 w-full" />
                <Skeleton className="h-64 w-full" />
              </div>
            )}
          </div>
        </section>

        <div className="grid gap-3 lg:grid-cols-[1fr_320px]">
          <Panel description={`${rangeLabel(timeline.range)} · click a band to filter the history`} title="Activity">
            <div className="p-3 pb-2">
              {p ? (
                <OutcomeAreaChart data={p.series} height={236} onSelectOutcome={(o) => onTimelineChange({ q: outcomeBandQuery(o), ev: undefined })} />
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
                  key={JSON.stringify([r.kind, r.type, r.id])}
                  kind={r.kind}
                  projectId={projectId}
                  type={r.type}
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
