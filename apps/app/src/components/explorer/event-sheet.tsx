import type { AuditEvent, EventDetail } from '@logbird/contracts';
import { OutcomeBadge, OutcomeDot, SeverityBadge, TypePill } from '@logbird/ui/components/badges';
import { CopyButton, CopyValue } from '@logbird/ui/components/copy-button';
import { EntityAvatar, EntityChip } from '@logbird/ui/components/entity-chip';
import { JsonViewer } from '@logbird/ui/components/json-viewer';
import { StableText } from '@logbird/ui/components/stable-text';
import { EmptyState, ErrorState } from '@logbird/ui/components/states';
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
  SearchXIcon,
  TerminalIcon,
  UserIcon,
  VenetianMaskIcon,
} from 'lucide-react';
import { type ComponentProps, type ReactNode, useState } from 'react';
import { ActionName } from '@/components/action-name';
import { EntityLink, EntityProfileLink } from '@/components/entity-link';
import { SupportAgentLink } from '@/components/impersonation';
import { Timestamp } from '@/components/timestamp';
import { ApiRequestError } from '@/lib/api/errors';
import { eventQuery, operationQuery } from '@/lib/api/queries';
import { targetEntityId, typeIcon } from '@/lib/entities';
import { actorAttributeHint, eventSentence, outcomeWasSent, parentActor, personLabel } from '@/lib/events';
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
  /** The id that was asked for, named in the not-found message. */
  missingId?: string;
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
  missingId,
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
            {missingError instanceof ApiRequestError && missingError.status === 404 ? (
              <>
                <SheetTitle className="sr-only">Event not found</SheetTitle>
                <EmptyState
                  className="w-full"
                  description={
                    <>
                      No event {missingId ? <span className="break-all font-mono text-foreground">{missingId}</span> : 'with this id'} is stored in
                      this project. It may be past the project's retention window, or the link has a typo.
                    </>
                  }
                  icon={SearchXIcon}
                  title="Event not found"
                />
              </>
            ) : (
              <>
                <SheetTitle className="sr-only">Could not load this event</SheetTitle>
                <ErrorState className="w-full" error={missingError} title="Could not load this event" />
              </>
            )}
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

/** Events can touch dozens of records; the drawer shows the first few and expands on request. */
const TARGET_PREVIEW = 5;

function TargetList({ targets, projectId, onFilter }: { targets: AuditEvent['targets']; projectId?: string; onFilter?: (term: string) => void }) {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? targets : targets.slice(0, TARGET_PREVIEW);
  const hidden = targets.length - visible.length;
  return (
    <ul className="flex flex-col divide-y rounded-lg border">
      {visible.map((t) => (
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
      {hidden > 0 ? (
        <li>
          <Button
            className="w-full justify-start rounded-none rounded-b-lg px-3 text-muted-foreground"
            onClick={() => setExpanded(true)}
            size="sm"
            variant="ghost"
          >
            <ChevronDownIcon />
            Show {hidden} more
          </Button>
        </li>
      ) : null}
    </ul>
  );
}

/** The drawer lists at most this many direct children; the operation page shows the full tree. */
const CHILD_PREVIEW = 5;
/** Above this many events the drawer does not load the whole operation just to list children. */
const CHILD_LOOKUP_MAX_OPERATION = 1000;

/**
 * Direct children of an event (events whose `context.parentEventId` is this event), read from its operation so the
 * operation page opens from the same cache. Children outside the operation, or in a very large one, are reached
 * through an explorer `parent:` search instead.
 */
function ChildEvents({ detail, event: e, projectId, indent }: { detail: EventDetail; event: AuditEvent; projectId: string; indent: number }) {
  const operationId = e.context.operationId;
  const lookup = Boolean(operationId) && detail.operationSize <= CHILD_LOOKUP_MAX_OPERATION;
  const op = useQuery({ ...operationQuery(projectId, operationId ?? ''), enabled: lookup });
  const children = (op.data ?? [])
    .filter((c) => c.context.parentEventId === e.id && c.id !== e.id)
    .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp) || a.id.localeCompare(b.id));
  const shown = children.slice(0, CHILD_PREVIEW);
  // Children recorded under another operation (or none loaded) are still reachable by searching their parent id.
  const missing = detail.childCount - shown.length;
  const allLabel = `View all ${detail.childCount}`;
  return (
    <>
      {lookup && op.isPending
        ? Array.from({ length: Math.min(detail.childCount, CHILD_PREVIEW) }, (_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: fixed-length skeleton rows.
            <li className="py-[3px]" key={i} style={{ paddingInlineStart: indent }}>
              <Skeleton className="h-4 w-3/4" />
            </li>
          ))
        : shown.map((c) => (
            <li className="flex items-center gap-2 text-[13px]" key={c.id} style={{ paddingInlineStart: indent }}>
              <OutcomeDot outcome={c.outcome} />
              <Link
                className="min-w-0 truncate py-[3px] hover:underline"
                dir="auto"
                params={{ projectId }}
                search={(prev) => ({ ...prev, ev: c.id })}
                to="/p/$projectId/events"
              >
                {eventSentence(c)}
              </Link>
              <Timestamp className="shrink-0 font-mono text-[11px] text-muted-foreground" format="ms" iso={c.timestamp} />
            </li>
          ))}
      {missing > 0 && !(lookup && op.isPending) ? (
        <li className="flex items-center gap-2 pt-1 text-xs" style={{ paddingInlineStart: indent }}>
          {operationId && children.length === detail.childCount ? (
            <Link
              className="inline-flex items-center gap-1 font-medium text-brand hover:underline"
              params={{ projectId, operationId }}
              search={{ focus: e.id }}
              to="/p/$projectId/operations/$operationId"
            >
              {allLabel} in the operation
              <ArrowRightIcon className="size-3" />
            </Link>
          ) : (
            <Link
              className="inline-flex items-center gap-1 font-medium text-brand hover:underline"
              params={{ projectId }}
              search={(prev) => ({ range: prev.range, q: formatTerm('parent', e.id) })}
              to="/p/$projectId/events"
            >
              {allLabel} in the explorer
              <ArrowRightIcon className="size-3" />
            </Link>
          )}
        </li>
      ) : null}
    </>
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

/** Neutral pill for events that did not send an outcome (stored as "success" by default). */
function OutcomeNotSent({ stored }: { stored: string }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            className="inline-flex h-5 cursor-default items-center gap-1.5 rounded-full bg-muted px-2 font-medium text-[11px] text-muted-foreground ring-1 ring-border ring-inset"
            data-testid="outcome-not-sent"
            type="button"
          >
            <span className="size-1.5 rounded-full border border-muted-foreground/60" />
            outcome not sent
          </button>
        }
      />
      <TooltipContent className="max-w-64">
        This event did not include an outcome, so Logbird files it as “{stored}” (it matches outcome:{stored}). Send outcome to record failures and
        denials.
      </TooltipContent>
    </Tooltip>
  );
}

/** "Not recorded", plus where the event (or the step that caused it) does name someone. */
function MissingActor({ event, detail, projectId }: { event: AuditEvent; detail?: EventDetail; projectId?: string }) {
  const fromAttribute = actorAttributeHint(event.attributes);
  const fromParent = detail ? parentActor(detail.parents) : null;
  return (
    <div className="flex min-w-0 flex-col gap-1" data-testid="missing-actor">
      <span className="text-muted-foreground text-sm">Not recorded</span>
      {fromAttribute ? (
        <span className="text-muted-foreground text-xs">
          Its <span className="font-mono">{fromAttribute.key}</span> attribute names{' '}
          <bdi className="font-medium text-foreground">{fromAttribute.value}</bdi>.
        </span>
      ) : null}
      {fromParent ? (
        <span className="flex min-w-0 flex-wrap items-center gap-1 text-muted-foreground text-xs">
          The step that caused it was done by
          {projectId && fromParent.id ? (
            <EntityProfileLink className="min-w-0 font-medium text-foreground hover:underline" id={fromParent.id} kind="actor" projectId={projectId}>
              <bdi className="truncate">{personLabel(fromParent)}</bdi>
            </EntityProfileLink>
          ) : (
            <bdi className="truncate font-medium text-foreground">{personLabel(fromParent)}</bdi>
          )}
        </span>
      ) : null}
      {fromAttribute || fromParent ? null : <span className="text-muted-foreground text-xs">The event did not include actor.id or actor.type.</span>}
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
  // `{}` / `[]` carry nothing to read here (the raw payload below keeps them).
  const attributes = Object.entries(e.attributes)
    .filter(([, v]) => v !== '{}' && v !== '[]')
    .sort(([a], [b]) => a.localeCompare(b));
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
          {outcomeWasSent(detail?.payload) === false ? <OutcomeNotSent stored={e.outcome} /> : <OutcomeBadge outcome={e.outcome} />}
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
            <StableText reserve={['Copy link', 'Link copied']}>{link.copied ? 'Link copied' : 'Copy link'}</StableText>
          </Button>
          <Button onClick={() => curl.copy(eventCurl(e))} size="xs" variant="outline">
            <TerminalIcon />
            <StableText reserve={['Copy as curl', 'Copied']}>{curl.copied ? 'Copied' : 'Copy as curl'}</StableText>
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

      <div className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]">
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
                <MissingActor detail={detail} event={e} projectId={projectId} />
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
            <TargetList key={e.id} onFilter={onFilter} projectId={projectId} targets={e.targets} />
          </Section>
        ) : null}

        {e.changes.length > 0 ? (
          <Section title={`Changes · ${e.changes.length}`}>
            <div className="overflow-hidden rounded-lg border">
              <table className="w-full table-fixed text-[13px]">
                <thead className="bg-muted/40 text-[11px] text-muted-foreground">
                  <tr>
                    <th className="w-1/4 px-3 py-1.5 text-start font-medium">Field</th>
                    <th className="w-3/8 px-3 py-1.5 text-start font-medium">Before</th>
                    <th className="w-3/8 px-3 py-1.5 text-start font-medium">After</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {e.changes.map((c) => {
                    const redacted = c.before === '[redacted]' || c.after === '[redacted]';
                    return (
                      <tr key={c.field}>
                        <td className="px-3 py-2 align-top font-mono text-[12px] [overflow-wrap:anywhere]">{c.field}</td>
                        <td className="px-3 py-2 align-top">
                          <span
                            className={cn(
                              'font-mono text-[12px] [overflow-wrap:anywhere]',
                              redacted ? 'text-muted-foreground italic' : 'text-diff-remove line-through decoration-diff-remove/40',
                            )}
                            dir="auto"
                          >
                            {c.before || <span className="text-muted-foreground no-underline">∅</span>}
                          </span>
                        </td>
                        <td className="px-3 py-2 align-top">
                          <span
                            className={cn(
                              'font-mono text-[12px] [overflow-wrap:anywhere]',
                              redacted ? 'text-muted-foreground italic' : 'text-diff-add',
                            )}
                            dir="auto"
                          >
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
                        dir="auto"
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
                      caused {detail.childCount} event{detail.childCount === 1 ? '' : 's'}
                    </span>
                  ) : null}
                </li>
                {detail && detail.childCount > 0 && projectId ? (
                  <ChildEvents detail={detail} event={e} indent={(detail.parents.length + 1) * 14} projectId={projectId} />
                ) : null}
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
          {/* min-h-6: the copy button arrives with the detail; the row is already its height, so nothing below moves. */}
          <div className="flex min-h-6 items-center justify-between">
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
