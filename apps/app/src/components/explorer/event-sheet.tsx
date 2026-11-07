import type { AuditEvent, EventDetail } from '@logbird/contracts';
import { OutcomeBadge, OutcomeDot, SeverityBadge, TypePill } from '@logbird/ui/components/badges';
import { CopyButton, CopyValue } from '@logbird/ui/components/copy-button';
import { EntityAvatar, EntityChip } from '@logbird/ui/components/entity-chip';
import { JsonViewer } from '@logbird/ui/components/json-viewer';
import { ErrorState } from '@logbird/ui/components/states';
import { Alert, AlertDescription } from '@logbird/ui/components/ui/alert';
import { Button } from '@logbird/ui/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@logbird/ui/components/ui/collapsible';
import { Kbd } from '@logbird/ui/components/ui/kbd';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@logbird/ui/components/ui/sheet';
import { Skeleton } from '@logbird/ui/components/ui/skeleton';
import { Tooltip, TooltipContent, TooltipTrigger } from '@logbird/ui/components/ui/tooltip';
import { useCopy } from '@logbird/ui/hooks/use-copy';
import { SUPPORT_SURFACE } from '@logbird/ui/lib/tones';
import { cn } from '@logbird/ui/lib/utils';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  ArrowRightIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CogIcon,
  FilterIcon,
  GitBranchIcon,
  LinkIcon,
  TerminalIcon,
  UserIcon,
  VenetianMaskIcon,
} from 'lucide-react';
import type { ComponentProps, ReactNode } from 'react';
import { ActionName } from '@/components/action-name';
import { EntityLink, EntityProfileLink } from '@/components/entity-link';
import { SupportAgentLink } from '@/components/impersonation';
import { Timestamp } from '@/components/timestamp';
import { ApiRequestError } from '@/lib/api/errors';
import { eventQuery } from '@/lib/api/queries';
import { targetEntityId, typeIcon } from '@/lib/entities';
import { eventSentence, personLabel } from '@/lib/events';
import { formatTimeMs } from '@/lib/format';
import { formatTerm } from '@/lib/query-language';
import { eventCurl } from '@/lib/snippets';

interface EventSheetProps {
  projectId?: string;
  /** Row data shown instantly while the detail (payload, parents) loads. */
  event: AuditEvent | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPrev?: () => void;
  onNext?: () => void;
  /** Add a filter term to the current query. */
  onFilter?: (term: string) => void;
  /** When false, the event has no detail endpoint (workspace activity). */
  fetchDetail?: boolean;
  /** Set when a deep-linked event could not be loaded. */
  missingError?: unknown;
  /**
   * Where focus goes when the sheet closes. The sheet opens from state (URL `?event=`), so it has no trigger to return
   * to by itself: pass the row that opened it.
   */
  finalFocus?: ComponentProps<typeof SheetContent>['finalFocus'];
}

export function EventSheet({
  projectId,
  event,
  open,
  onOpenChange,
  onPrev,
  onNext,
  onFilter,
  fetchDetail = true,
  missingError,
  finalFocus,
}: EventSheetProps) {
  const detail = useQuery({ ...eventQuery(projectId ?? '', event?.id ?? ''), enabled: open && fetchDetail && Boolean(projectId && event) });
  const e = detail.data?.event ?? event;
  return (
    <Sheet onOpenChange={onOpenChange} open={open}>
      <SheetContent className="w-full gap-0 p-0 data-[side=right]:w-full data-[side=right]:sm:max-w-[640px]" finalFocus={finalFocus} showCloseButton>
        {e ? (
          <EventDetailBody
            detail={detail.data}
            detailError={detail.isError ? detail.error : null}
            detailLoading={fetchDetail && detail.isPending}
            event={e}
            onFilter={onFilter}
            onNext={onNext}
            onPrev={onPrev}
            onRetry={() => detail.refetch()}
            projectId={projectId}
          />
        ) : missingError ? (
          <div className="flex flex-1 items-center p-6">
            <SheetTitle className="sr-only">Event not found</SheetTitle>
            <ErrorState
              className="w-full"
              error={missingError}
              title={missingError instanceof ApiRequestError && missingError.status === 404 ? 'Event not found' : 'Could not load this event'}
            />
          </div>
        ) : (
          <div className="flex flex-col gap-3 p-6">
            <SheetTitle className="sr-only">Loading event</SheetTitle>
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-6 w-3/4" />
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-40 w-full" />
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

function Section({ title, children, actions, className }: { title: string; children: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <section className={cn('flex flex-col gap-2.5 border-b px-5 py-4 last:border-b-0', className)}>
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-medium text-[11px] text-muted-foreground uppercase tracking-wider">{title}</h3>
        {actions}
      </div>
      {children}
    </section>
  );
}

function FilterButton({ term, onFilter }: { term: string; onFilter?: (term: string) => void }) {
  if (!onFilter) return null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={`Filter by ${term}`}
            className="text-muted-foreground opacity-0 group-hover/kv:opacity-100 focus-visible:opacity-100"
            onClick={() => onFilter(term)}
            size="icon-xs"
            variant="ghost"
          />
        }
      >
        <FilterIcon />
      </TooltipTrigger>
      <TooltipContent>
        Filter <span className="font-mono">{term}</span>
      </TooltipContent>
    </Tooltip>
  );
}

function KV({
  label,
  value,
  mono = true,
  term,
  onFilter,
  copy = true,
}: {
  label: string;
  value: string;
  mono?: boolean;
  term?: string;
  onFilter?: (t: string) => void;
  copy?: boolean;
}) {
  if (!value) return null;
  return (
    <div className="group/kv grid min-h-7 grid-cols-[120px_1fr_auto] items-center gap-3 text-[13px]">
      <dt className="truncate text-muted-foreground">{label}</dt>
      {/* The filter action belongs to the value: inside the dd (a <dl> group may only hold dt/dd), laid out as the third
          grid column through display: contents. */}
      <dd className="contents">
        <span className="min-w-0">
          {copy ? (
            <CopyValue className={mono ? undefined : 'font-sans text-[13px]'} value={value} />
          ) : (
            <span className={cn('break-all', mono && 'font-mono text-[12px]')}>{value}</span>
          )}
        </span>
        <span className="flex items-center">{term ? <FilterButton onFilter={onFilter} term={term} /> : null}</span>
      </dd>
    </div>
  );
}

function PartyCard({
  label,
  hint,
  icon,
  children,
  tone = 'default',
}: {
  label: string;
  hint: string;
  icon: ReactNode;
  children: ReactNode;
  tone?: 'default' | 'support';
}) {
  return (
    <div className={cn('flex min-w-0 flex-col gap-2 overflow-hidden rounded-lg border p-3', tone === 'support' ? SUPPORT_SURFACE : 'bg-muted/25')}>
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        {icon}
        <span className="font-medium text-foreground/80 uppercase tracking-wider">{label}</span>
        <span className="truncate">· {hint}</span>
      </div>
      {children}
    </div>
  );
}

function EventDetailBody({
  event: e,
  detail,
  detailLoading,
  detailError,
  projectId,
  onPrev,
  onNext,
  onFilter,
  onRetry,
}: {
  event: AuditEvent;
  detail: EventDetail | undefined;
  detailLoading: boolean;
  detailError: unknown;
  projectId?: string;
  onPrev?: () => void;
  onNext?: () => void;
  onFilter?: (term: string) => void;
  onRetry: () => void;
}) {
  const link = useCopy();
  const curl = useCopy();
  const shareUrl =
    typeof window === 'undefined' ? '' : `${window.location.origin}/p/${projectId}/events?q=${encodeURIComponent(`id:${e.id}`)}&ev=${e.id}`;
  const attributes = Object.entries(e.attributes).sort(([a], [b]) => a.localeCompare(b));
  const ctx = e.context;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex flex-col gap-3 border-b px-5 pt-4 pb-4">
        <div className="flex items-center gap-1 pe-10">
          <Button aria-label="Previous event" className="pointer-coarse:size-11" disabled={!onPrev} onClick={onPrev} size="icon-xs" variant="ghost">
            <ChevronLeftIcon />
          </Button>
          <Button aria-label="Next event" className="pointer-coarse:size-11" disabled={!onNext} onClick={onNext} size="icon-xs" variant="ghost">
            <ChevronRightIcon />
          </Button>
          <span className="ms-1 hidden items-center gap-1 text-[11px] text-muted-foreground sm:flex">
            <Kbd>k</Kbd>
            <Kbd>j</Kbd> to move · <Kbd>esc</Kbd> to close
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <OutcomeBadge outcome={e.outcome} />
          <SeverityBadge severity={e.severity} />
          <TypePill>{e.environment}</TypePill>
          {e.source ? <TypePill tone="brand">via {e.source}</TypePill> : null}
        </div>
        <SheetTitle className="font-semibold text-[17px] leading-snug tracking-tight" dir="auto">
          {eventSentence(e)}
        </SheetTitle>
        <SheetDescription className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px]">
          <ActionName action={e.action} className="text-[12.5px]" />
          <span className="text-muted-foreground">
            <Timestamp format="full" iso={e.timestamp} /> · <Timestamp format="relative" iso={e.timestamp} />
          </span>
        </SheetDescription>
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={() => link.copy(shareUrl)} size="xs" variant="outline">
            <LinkIcon />
            {link.copied ? 'Link copied' : 'Copy link'}
          </Button>
          <Button onClick={() => curl.copy(eventCurl(e))} size="xs" variant="outline">
            <TerminalIcon />
            {curl.copied ? 'Copied' : 'Copy as curl'}
          </Button>
          {ctx.operationId && projectId ? (
            <Button
              nativeButton={false}
              render={
                <Link params={{ projectId, operationId: ctx.operationId }} search={{ focus: e.id }} to="/p/$projectId/operations/$operationId" />
              }
              size="xs"
              variant="outline"
            >
              <GitBranchIcon />
              View operation{detail?.operationSize ? ` · ${detail.operationSize}` : ''}
            </Button>
          ) : null}
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <Section title="Who">
          {e.impersonator ? (
            <Alert className="py-2" role="note" variant="support">
              <VenetianMaskIcon aria-hidden />
              <AlertDescription className="text-[13px] text-foreground">
                <span>
                  Support agent <bdi className="font-medium">{e.impersonator.name || e.impersonator.id}</bdi> did this while signed in as{' '}
                  <bdi className="font-medium">{personLabel(e.actor) || 'an unknown customer'}</bdi>. The actor is whose account it was; the support
                  agent was at the keyboard.
                </span>
              </AlertDescription>
            </Alert>
          ) : null}
          <div className={cn('grid gap-2', e.impersonator ? 'sm:grid-cols-3' : 'sm:grid-cols-2')}>
            <PartyCard hint={e.impersonator ? 'whose account' : 'who caused it'} icon={<UserIcon className="size-3" />} label="Actor">
              {e.actor ? (
                <div className="flex min-w-0 flex-col gap-1">
                  {projectId ? (
                    <EntityLink id={e.actor.id} kind="actor" name={e.actor.name} projectId={projectId} type={e.actor.type} />
                  ) : (
                    <span className="truncate text-sm">{personLabel(e.actor)}</span>
                  )}
                  <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground text-xs">
                    <TypePill>{e.actor.type || 'unknown'}</TypePill>
                    <span className="truncate font-mono">{e.actor.id}</span>
                  </span>
                  {e.actor.email ? <span className="truncate text-muted-foreground text-xs">{e.actor.email}</span> : null}
                </div>
              ) : (
                <span className="text-muted-foreground text-sm">Not recorded</span>
              )}
            </PartyCard>
            <PartyCard hint="who performed it" icon={<CogIcon className="size-3" />} label="Executor">
              {e.executor?.id ? (
                <div className="flex min-w-0 flex-col gap-1">
                  {projectId ? (
                    <EntityLink
                      id={e.executor.id}
                      kind="executor"
                      name={e.executor.name || e.executor.id}
                      projectId={projectId}
                      type={e.executor.type}
                    />
                  ) : (
                    <span className="truncate text-sm">{e.executor.name || e.executor.id}</span>
                  )}
                  <span className="flex flex-wrap items-center gap-1.5 text-muted-foreground text-xs">
                    <TypePill>{e.executor.type || 'unknown'}</TypePill>
                    {e.executor.jobId ? <span className="font-mono">job {e.executor.jobId}</span> : null}
                    {e.executor.attempt > 0 ? (
                      <TypePill tone={e.executor.attempt > 1 ? 'warning' : 'neutral'}>attempt {e.executor.attempt}</TypePill>
                    ) : null}
                  </span>
                </div>
              ) : (
                <span className="text-muted-foreground text-sm">Not recorded</span>
              )}
            </PartyCard>
            {e.impersonator ? (
              <PartyCard hint="at the keyboard" icon={<VenetianMaskIcon className="size-3 text-support" />} label="Support" tone="support">
                <div className="flex min-w-0 flex-col gap-1">
                  {projectId ? (
                    <SupportAgentLink
                      agentId={e.impersonator.id}
                      className="min-w-0 rounded-sm outline-none hover:underline hover:decoration-muted-foreground/40 hover:underline-offset-2 focus-visible:ring-2 focus-visible:ring-ring/50"
                      projectId={projectId}
                    >
                      <EntityChip id={e.impersonator.id} name={e.impersonator.name || e.impersonator.id} />
                    </SupportAgentLink>
                  ) : (
                    <span className="truncate text-sm">{e.impersonator.name || e.impersonator.id}</span>
                  )}
                  <span className="truncate font-mono text-muted-foreground text-xs">{e.impersonator.id}</span>
                  {projectId ? (
                    <SupportAgentLink
                      agentId={e.impersonator.id}
                      className="inline-flex items-center gap-1 self-start whitespace-nowrap text-muted-foreground text-xs underline-offset-2 hover:text-foreground hover:underline"
                      projectId={projectId}
                    >
                      Everything they did as support
                      <ArrowRightIcon aria-hidden className="size-3 shrink-0" />
                    </SupportAgentLink>
                  ) : null}
                </div>
              </PartyCard>
            ) : null}
          </div>
          {e.tenant ? (
            <div className="group/kv flex items-center justify-between gap-2 rounded-lg border bg-muted/25 px-3 py-2">
              <div className="flex min-w-0 items-center gap-2 text-sm">
                <span className="text-[11px] text-muted-foreground uppercase tracking-wider">Tenant</span>
                {projectId ? <EntityLink id={e.tenant.id} kind="tenant" name={e.tenant.name} projectId={projectId} /> : <span>{e.tenant.name}</span>}
                <span className="hidden truncate font-mono text-muted-foreground text-xs sm:inline">{e.tenant.id}</span>
              </div>
              <FilterButton onFilter={onFilter} term={formatTerm('tenant', e.tenant.id)} />
            </div>
          ) : null}
        </Section>

        {e.targets.length > 0 ? (
          <Section title={`Targets · ${e.targets.length}`}>
            <ul className="flex flex-col divide-y rounded-lg border">
              {e.targets.map((t) => (
                <li className="group/kv flex items-center gap-2 px-3 py-2" key={`${t.type}:${t.id}`}>
                  <EntityAvatar icon={typeIcon('target', t.type)} id={targetEntityId(t.type, t.id)} name={t.name || t.id} size="md" square />
                  <div className="flex min-w-0 flex-1 flex-col">
                    {projectId ? (
                      <EntityProfileLink
                        className="truncate font-medium text-sm hover:underline"
                        id={targetEntityId(t.type, t.id)}
                        kind="target"
                        projectId={projectId}
                      >
                        {t.name || t.id}
                      </EntityProfileLink>
                    ) : (
                      <span className="truncate font-medium text-sm">{t.name || t.id}</span>
                    )}
                    <span className="flex items-center gap-1.5 text-muted-foreground text-xs">
                      <TypePill>{t.type}</TypePill>
                      <span className="truncate font-mono">{t.id}</span>
                    </span>
                  </div>
                  <FilterButton onFilter={onFilter} term={formatTerm('target', t.id)} />
                  {projectId ? (
                    <Button
                      aria-label={`Follow ${t.name || t.id}`}
                      nativeButton={false}
                      render={<Link params={{ projectId, entityId: targetEntityId(t.type, t.id) }} to="/p/$projectId/records/$entityId" />}
                      size="icon-xs"
                      variant="ghost"
                    >
                      <ArrowRightIcon />
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          </Section>
        ) : null}

        {e.changes.length > 0 ? (
          <Section title={`Changes · ${e.changes.length}`}>
            <div className="overflow-hidden rounded-lg border">
              <table className="w-full text-[13px]">
                <thead className="bg-muted/40 text-[11px] text-muted-foreground">
                  <tr>
                    <th className="w-1/4 px-3 py-1.5 text-start font-medium">Field</th>
                    <th className="px-3 py-1.5 text-start font-medium">Before</th>
                    <th className="px-3 py-1.5 text-start font-medium">After</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {e.changes.map((c) => {
                    const redacted = c.before === '[redacted]' || c.after === '[redacted]';
                    return (
                      <tr key={c.field}>
                        <td className="px-3 py-2 align-top font-mono text-[12px]">{c.field}</td>
                        <td className="px-3 py-2 align-top">
                          <span
                            className={cn(
                              'break-all font-mono text-[12px]',
                              redacted ? 'text-muted-foreground italic' : 'text-diff-remove line-through decoration-diff-remove/40',
                            )}
                          >
                            {c.before || <span className="text-muted-foreground no-underline">∅</span>}
                          </span>
                        </td>
                        <td className="px-3 py-2 align-top">
                          <span className={cn('break-all font-mono text-[12px]', redacted ? 'text-muted-foreground italic' : 'text-diff-add')}>
                            {c.after || <span className="text-muted-foreground">∅</span>}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Section>
        ) : null}

        {ctx.parentEventId || ctx.operationId ? (
          <Section title="Causation">
            {detailLoading ? (
              <Skeleton className="h-8 w-full" />
            ) : (
              <ol aria-label="Causation chain" className="flex flex-col">
                {(detail?.parents ?? []).map((p, i) => (
                  <li className="flex items-center gap-2 text-[13px]" key={p.id} style={{ paddingInlineStart: i * 14 }}>
                    <OutcomeDot outcome={p.outcome} />
                    {projectId ? (
                      <Link
                        className="min-w-0 truncate py-[3px] hover:underline"
                        params={{ projectId }}
                        search={(prev) => ({ ...prev, ev: p.id })}
                        to="/p/$projectId/events"
                      >
                        {eventSentence(p)}
                      </Link>
                    ) : (
                      <span className="truncate" dir="auto">
                        {eventSentence(p)}
                      </span>
                    )}
                    <Timestamp className="shrink-0 font-mono text-[11px] text-muted-foreground" format="ms" iso={p.timestamp} />
                  </li>
                ))}
                <li className="flex items-center gap-2 font-medium text-[13px]" style={{ paddingInlineStart: (detail?.parents.length ?? 0) * 14 }}>
                  <OutcomeDot outcome={e.outcome} />
                  <span className="min-w-0 truncate">This event</span>
                  {detail && detail.childCount > 0 ? (
                    <span className="shrink-0 font-normal text-muted-foreground text-xs">
                      → {detail.childCount} child event{detail.childCount === 1 ? '' : 's'}
                    </span>
                  ) : null}
                </li>
                {ctx.parentEventId && (detail?.parents.length ?? 0) === 0 ? (
                  <li className="text-muted-foreground text-xs">Parent {ctx.parentEventId} is not stored (outside retention or never sent).</li>
                ) : null}
              </ol>
            )}
          </Section>
        ) : null}

        <Section title="Context">
          <dl className="flex flex-col">
            <KV label="Event id" onFilter={onFilter} term={formatTerm('id', e.id)} value={e.id} />
            <KV label="Operation" onFilter={onFilter} term={formatTerm('operation', ctx.operationId)} value={ctx.operationId} />
            <KV label="Parent event" onFilter={onFilter} term={formatTerm('id', ctx.parentEventId)} value={ctx.parentEventId} />
            <KV label="Request" onFilter={onFilter} term={formatTerm('request', ctx.requestId)} value={ctx.requestId} />
            <KV label="Trace" onFilter={onFilter} term={formatTerm('trace', ctx.traceId)} value={ctx.traceId} />
            <KV label="IP" value={ctx.ip} />
            <KV label="User agent" mono={false} value={ctx.userAgent} />
            <KV
              copy={false}
              label="Received"
              mono={false}
              value={`${formatTimeMs(e.receivedAt)} (${Math.max(0, Date.parse(e.receivedAt) - Date.parse(e.timestamp))} ms after it happened)`}
            />
            <KV copy={false} label="Conformance" mono={false} value={`${e.conformance}% of the recommended envelope`} />
            <KV copy={false} label="SDK" value={[e.sdk, e.schemaVersion ? `schema v${e.schemaVersion}` : ''].filter(Boolean).join(' · ')} />
          </dl>
        </Section>

        {attributes.length > 0 ? (
          <Section title={`Attributes · ${attributes.length}`}>
            <dl className="flex flex-col">
              {attributes.map(([k, v]) => (
                <KV key={k} label={k} onFilter={onFilter} term={formatTerm(`attr.${k}`, v)} value={v} />
              ))}
            </dl>
          </Section>
        ) : null}

        <Collapsible className="border-b px-5 py-4" defaultOpen={false}>
          <div className="flex items-center justify-between">
            <CollapsibleTrigger className="group/raw flex items-center gap-1.5 font-medium text-[11px] text-muted-foreground uppercase tracking-wider outline-none hover:text-foreground">
              <ChevronDownIcon className="-rotate-90 size-3.5 transition-transform group-data-[panel-open]/raw:rotate-0" />
              Raw payload
            </CollapsibleTrigger>
            {detail ? <CopyButton label="Copy JSON" value={JSON.stringify(detail.payload, null, 2)} /> : null}
          </div>
          <CollapsibleContent className="pt-3">
            {detailError ? (
              <ErrorState error={detailError} onRetry={onRetry} size="sm" title="Could not load the raw payload" />
            ) : detail ? (
              <div className="max-h-[420px] overflow-auto rounded-lg border bg-muted/30 p-3">
                <JsonViewer defaultExpandDepth={2} value={detail.payload} />
              </div>
            ) : detailLoading ? (
              <Skeleton className="h-40 w-full" />
            ) : (
              <div className="max-h-[420px] overflow-auto rounded-lg border bg-muted/30 p-3">
                <JsonViewer defaultExpandDepth={2} value={e} />
              </div>
            )}
          </CollapsibleContent>
        </Collapsible>
      </div>
    </div>
  );
}
