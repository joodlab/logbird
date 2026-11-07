import { CopyValue } from '@logbird/ui/components/copy-button';
import { EntityAvatar } from '@logbird/ui/components/entity-chip';
import { Panel } from '@logbird/ui/components/page-header';
import { StatTile, StatTileGrid } from '@logbird/ui/components/stat-card';
import { EmptyState } from '@logbird/ui/components/states';
import { Alert, AlertDescription, AlertTitle } from '@logbird/ui/components/ui/alert';
import { Button } from '@logbird/ui/components/ui/button';
import { Skeleton } from '@logbird/ui/components/ui/skeleton';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { CircleAlertIcon, RotateCwIcon, Rows3Icon, UserIcon, VenetianMaskIcon } from 'lucide-react';
import { useEffect, useRef } from 'react';
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
import { failureSummary } from '@/lib/query-budget';
import { formatTerm } from '@/lib/query-language';
import { rangeLabel, rangePhrase } from '@/lib/range';
import { useDocumentTitle } from '@/lib/use-document-title';

interface SupportAgentProfileProps {
  projectId: string;
  agentId: string;
  timeline: ExplorerState;
  onTimelineChange: (patch: Partial<ExplorerState>) => void;
}

/** A panel or tile whose own query failed: says so (never an endless skeleton or a false "nothing"). */
function CouldNotLoad({ className }: { className?: string }) {
  return (
    <p className={className ?? 'flex items-center gap-1.5 px-3 py-6 text-muted-foreground text-xs'}>
      <CircleAlertIcon aria-hidden className="size-3.5 shrink-0" />
      Couldn't load
    </p>
  );
}

/**
 * Everything one support agent did while signed in as customers. The agent may never act under their own account,
 * so this page is built from `impersonator:<id>` rather than the actor directory. It opens on 7 days; every summary
 * query can fail on its own (busy projects, long ranges), so each panel says when it couldn't load and one banner
 * offers a shorter range or a retry of everything that failed.
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
  const summaries = [self, actedAs, tenants, actions, series];
  const failure = failureSummary(summaries);
  const retryFailed = () => {
    for (const q of [...summaries, ownAccount]) if (q.isError) void q.refetch();
  };
  const retrying = summaries.some((q) => q.isError && q.isFetching);
  // When the banner goes away (a shorter range, or Retry worked) focus would drop to <body>: hand it to the heading.
  const heading = useRef<HTMLHeadingElement>(null);
  const hadFailure = useRef(false);
  useEffect(() => {
    if (failure) hadFailure.current = true;
    else if (hadFailure.current) {
      hadFailure.current = false;
      if (document.activeElement === document.body || document.activeElement === null) heading.current?.focus();
    }
  }, [failure]);

  const fresh = (q: { isPlaceholderData: boolean; data?: unknown }) => (q.isPlaceholderData ? undefined : q.data);
  const selfData = fresh(self) as typeof self.data;
  const name = selfData?.values[0]?.label || ownAccount.data?.values[0]?.label || agentId;
  const total = selfData ? (selfData.values[0]?.count ?? 0) : undefined;
  const actedAsData = fresh(actedAs) as typeof actedAs.data;
  const tenantData = fresh(tenants) as typeof tenants.data;
  const actionData = fresh(actions) as typeof actions.data;
  const ownEvents = fresh(ownAccount) ? (ownAccount.data?.values[0]?.count ?? 0) : 0;
  // Nobody with this id did anything as support in range: one empty state, no callout or zero tiles (n3).
  const none = total === 0;
  const phrase = rangePhrase(range);
  useSetCrumb(name);
  useDocumentTitle(`${name} · Support agent · Logbird`);

  const failedValue = <span className="font-normal text-muted-foreground text-sm">Couldn't load</span>;

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
                <h1 className="truncate font-semibold text-xl tracking-tight outline-none" ref={heading} tabIndex={-1}>
                  <bdi>{name}</bdi>
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

        {failure ? (
          <Alert data-testid="agent-page-failure">
            <CircleAlertIcon />
            <AlertTitle>
              {failure === 'budget' ? `Couldn't summarise ${phrase}. It may hold too many events.` : "Some of this page couldn't load."}
            </AlertTitle>
            <AlertDescription>
              {failure === 'budget' ? 'Try a shorter range, or retry.' : null}
              <span className="mt-2 flex flex-wrap gap-2">
                {failure === 'budget' && range !== '7d' ? (
                  <Button onClick={() => onTimelineChange({ range: '7d', ev: undefined })} size="sm" variant="outline">
                    Last 7 days
                  </Button>
                ) : null}
                {failure === 'budget' && range !== '24h' ? (
                  <Button onClick={() => onTimelineChange({ range: '24h', ev: undefined })} size="sm" variant="outline">
                    Last 24 hours
                  </Button>
                ) : null}
                {/* aria-disabled, not disabled: the button keeps focus while its retry runs. */}
                <Button aria-disabled={retrying} onClick={() => (retrying ? undefined : retryFailed())} size="sm" variant="ghost">
                  <RotateCwIcon />
                  Retry
                </Button>
              </span>
            </AlertDescription>
          </Alert>
        ) : null}

        {none ? (
          <EmptyState
            description={`Nobody with the id ${agentId} signed in as a customer in ${phrase}. Check the id, or try a wider range.`}
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
          <>
            <Alert role="note" variant="support">
              <VenetianMaskIcon />
              <AlertDescription className="text-[13px] text-foreground">
                <span>
                  These are the actions <bdi className="font-medium">{name}</bdi> did while signed in as customers. Each one is recorded under the
                  customer's name; <bdi>{name}</bdi> was at the keyboard.
                  {ownEvents > 0 ? ' What they did under their own account is on their actor page.' : null}
                </span>
              </AlertDescription>
            </Alert>

            <StatTileGrid className="grid-cols-2 sm:grid-cols-3">
              <StatTile
                className="col-span-2 sm:col-span-1"
                label={`Done as support · ${rangeLabel(range)}`}
                loading={total === undefined && !self.isError}
                value={self.isError && total === undefined ? failedValue : formatNumber(total ?? 0)}
              />
              <StatTile
                label="Customers acted as"
                loading={!actedAsData && !actedAs.isError}
                value={actedAs.isError && !actedAsData ? failedValue : distinctCount(actedAsData, formatNumber)}
              />
              <StatTile
                label="Tenants acted in"
                loading={!tenantData && !tenants.isError}
                value={tenants.isError && !tenantData ? failedValue : distinctCount(tenantData, formatNumber)}
              />
            </StatTileGrid>

            <div className="grid grid-cols-[minmax(0,1fr)] gap-3 lg:grid-cols-[minmax(0,1fr)_320px]">
              <Panel className="self-start" description="Click a band to filter the timeline below" title="Activity as support">
                <div className="p-3 pb-2">
                  {series.data ? (
                    <OutcomeAreaChart
                      data={series.data}
                      height={200}
                      onSelectOutcome={(o) => onTimelineChange({ q: formatTerm('outcome', o), ev: undefined })}
                    />
                  ) : series.isError ? (
                    <CouldNotLoad className="flex h-[208px] items-center justify-center gap-1.5 text-muted-foreground text-xs" />
                  ) : (
                    <Skeleton className="h-[208px] w-full" />
                  )}
                </div>
              </Panel>
              <div className="flex min-w-0 flex-col gap-3">
                <Panel description="Whose account they were using" title="Acted as">
                  {actedAs.isError && !actedAsData ? (
                    <CouldNotLoad />
                  ) : (
                    <RankList
                      items={(actedAsData?.values ?? []).slice(0, 6).map((v) => ({
                        key: v.value,
                        label: (
                          <span className="truncate">
                            <bdi>{v.label || v.value}</bdi>
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
                  )}
                </Panel>
                <Panel title="Top actions">
                  {actions.isError && !actionData ? (
                    <CouldNotLoad />
                  ) : (
                    <RankList
                      items={(actionData?.values ?? []).map((a) => ({
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
                      loading={!actionData}
                      rows={4}
                    />
                  )}
                </Panel>
              </div>
            </div>
          </>
        )}
      </div>

      {none ? null : (
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
