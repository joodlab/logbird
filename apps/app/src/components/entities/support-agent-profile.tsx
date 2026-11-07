import { CopyValue } from '@logbird/ui/components/copy-button';
import { EntityAvatar } from '@logbird/ui/components/entity-chip';
import { Panel } from '@logbird/ui/components/page-header';
import { StatTile, StatTileGrid } from '@logbird/ui/components/stat-card';
import { EmptyState, ErrorState } from '@logbird/ui/components/states';
import { Button } from '@logbird/ui/components/ui/button';
import { Skeleton } from '@logbird/ui/components/ui/skeleton';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Rows3Icon, UserIcon, VenetianMaskIcon } from 'lucide-react';
import { ActionName } from '@/components/action-name';
import { OutcomeAreaChart } from '@/components/charts/outcome-area-chart';
import { EntityProfileLink } from '@/components/entity-link';
import { Explorer, type ExplorerState } from '@/components/explorer/explorer';
import { RankList } from '@/components/rank-list';
import { facetQuery, histogramQuery } from '@/lib/api/queries';
import { useSetCrumb } from '@/lib/crumbs';
import { formatNumber } from '@/lib/format';
import { distinctCount, SUPPORT_TERM, supportAgentQuery } from '@/lib/impersonation';
import { withPresence } from '@/lib/presence-filter';
import { formatTerm } from '@/lib/query-language';
import { rangeLabel } from '@/lib/range';
import { useDocumentTitle } from '@/lib/use-document-title';

interface SupportAgentProfileProps {
  projectId: string;
  agentId: string;
  timeline: ExplorerState;
  onTimelineChange: (patch: Partial<ExplorerState>) => void;
}

/**
 * Everything one support agent did while signed in as customers. The agent may never act under their own account,
 * so this page is built from `impersonator:<id>` rather than the actor directory.
 */
export function SupportAgentProfile({ projectId, agentId, timeline, onTimelineChange }: SupportAgentProfileProps) {
  const baseQuery = supportAgentQuery(agentId);
  const { range } = timeline;
  const self = useQuery(facetQuery(projectId, 'impersonator', range, baseQuery, 1));
  const actedAs = useQuery(facetQuery(projectId, 'actor', range, withPresence(baseQuery, 'actor'), 100));
  const tenants = useQuery(facetQuery(projectId, 'tenant', range, withPresence(baseQuery, 'tenant'), 100));
  const actions = useQuery(facetQuery(projectId, 'action', range, baseQuery, 5));
  const series = useQuery(histogramQuery(projectId, range, baseQuery));
  // Their own account, if they also act as themselves: link it, never mix the two.
  const ownAccount = useQuery(facetQuery(projectId, 'actor', range, formatTerm('actor', agentId), 1));

  const fresh = (q: { isPlaceholderData: boolean; data?: unknown }) => (q.isPlaceholderData ? undefined : q.data);
  const selfData = fresh(self) as typeof self.data;
  const name = selfData?.values[0]?.label || ownAccount.data?.values[0]?.label || agentId;
  const total = selfData ? (selfData.values[0]?.count ?? 0) : undefined;
  const actedAsData = fresh(actedAs) as typeof actedAs.data;
  const tenantData = fresh(tenants) as typeof tenants.data;
  const ownEvents = fresh(ownAccount) ? (ownAccount.data?.values[0]?.count ?? 0) : 0;
  useSetCrumb(name);
  useDocumentTitle(`${name} · Support agent · Logbird`);

  return (
    <div className="flex flex-col">
      <div className="flex flex-col gap-5 p-4 sm:p-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex min-w-0 items-center gap-4">
            <EntityAvatar id={agentId} name={name} size="lg" />
            <div className="flex min-w-0 flex-col gap-1">
              <div className="flex items-center gap-1.5 text-muted-foreground text-xs">
                <VenetianMaskIcon aria-hidden className="size-3.5 text-support" />
                <span>Support agent</span>
              </div>
              {self.isPending ? (
                <Skeleton className="h-7 w-48" />
              ) : (
                <h1 className="truncate font-semibold text-xl tracking-tight" dir="auto">
                  {name}
                </h1>
              )}
              <CopyValue className="text-muted-foreground" value={agentId} />
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {ownEvents > 0 ? (
              <Button
                nativeButton={false}
                render={<Link params={{ projectId, entityId: agentId }} to="/p/$projectId/actors/$entityId" />}
                size="sm"
                variant="outline"
              >
                <UserIcon />
                Their own account
              </Button>
            ) : null}
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

        <p className="flex items-start gap-2 rounded-md border border-support/25 bg-support/5 px-3 py-2 text-[13px]">
          <VenetianMaskIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-support" />
          <span>
            These are the actions <span className="font-medium">{name}</span> did while signed in as customers. Each one is recorded under the
            customer's name; {name} was at the keyboard.
            {ownEvents > 0 ? ` What ${name} did under their own account is on their actor page.` : null}
          </span>
        </p>

        {self.isError && !selfData ? (
          <ErrorState error={self.error} onRetry={() => self.refetch()} size="sm" title="Could not load this support agent" />
        ) : (
          <StatTileGrid className="grid-cols-2 sm:grid-cols-3">
            <StatTile
              className="col-span-2 sm:col-span-1"
              label={`Done as support · ${rangeLabel(range).toLowerCase()}`}
              loading={total === undefined}
              value={formatNumber(total ?? 0)}
            />
            <StatTile
              label="Customers acted as"
              loading={!actedAsData && !actedAs.isError}
              value={actedAs.isError ? '—' : distinctCount(actedAsData, formatNumber)}
            />
            <StatTile
              label="Tenants"
              loading={!tenantData && !tenants.isError}
              value={tenants.isError ? '—' : distinctCount(tenantData, formatNumber)}
            />
          </StatTileGrid>
        )}

        {self.isError && !selfData ? null : total === 0 ? (
          <EmptyState
            description={`Nobody with the id ${agentId} signed in as a customer in ${rangeLabel(range).toLowerCase()}. Check the id, or try a wider range.`}
            icon={VenetianMaskIcon}
            size="sm"
            title="No support activity in this range"
          >
            <Button
              nativeButton={false}
              render={<Link params={{ projectId }} search={(prev) => ({ range: prev.range, q: SUPPORT_TERM })} to="/p/$projectId/events" />}
              size="sm"
              variant="outline"
            >
              <VenetianMaskIcon />
              Everything support did
            </Button>
          </EmptyState>
        ) : (
          <div className="grid gap-3 lg:grid-cols-[1fr_320px]">
            <Panel description="Click a band to filter the timeline below" title="Activity as support">
              <div className="p-3 pb-2">
                {series.data ? (
                  <OutcomeAreaChart
                    data={series.data}
                    height={200}
                    onSelectOutcome={(o) => onTimelineChange({ q: formatTerm('outcome', o), ev: undefined })}
                  />
                ) : (
                  <Skeleton className="h-[208px] w-full" />
                )}
              </div>
            </Panel>
            <div className="flex flex-col gap-3">
              <Panel description="Whose account they were using" title="Acted as">
                <RankList
                  items={(actedAsData?.values ?? []).slice(0, 6).map((v) => ({
                    key: v.value,
                    label: (
                      <span className="truncate" dir="auto">
                        {v.label || v.value}
                      </span>
                    ),
                    count: v.count,
                    render: (children, className) => (
                      <EntityProfileLink className={className} id={v.value} kind="actor" projectId={projectId}>
                        {children}
                      </EntityProfileLink>
                    ),
                  }))}
                  loading={!actedAsData}
                  rows={4}
                />
              </Panel>
              <Panel title="Top actions">
                <RankList
                  items={(actions.data?.values ?? []).map((a) => ({
                    key: a.value,
                    label: <ActionName action={a.value} />,
                    count: a.count,
                    render: (children, className) => (
                      <button
                        className={className}
                        onClick={() => onTimelineChange({ q: formatTerm('action', a.value), ev: undefined })}
                        type="button"
                      >
                        {children}
                      </button>
                    ),
                  }))}
                  loading={actions.isPending}
                  rows={4}
                />
              </Panel>
            </div>
          </div>
        )}
      </div>

      {total === 0 || (self.isError && !selfData) ? null : (
        <section aria-label="Timeline" className="flex flex-col border-t">
          <div className="flex items-center justify-between px-4 pt-4 sm:px-6">
            <h2 className="font-medium text-sm">What they did as support</h2>
          </div>
          <div className="flex h-[640px] min-h-0 flex-col">
            <Explorer
              baseLabel={`support: ${name}`}
              baseQuery={baseQuery}
              embedded
              onChange={onTimelineChange}
              projectId={projectId}
              state={timeline}
            />
          </div>
        </section>
      )}
    </div>
  );
}
