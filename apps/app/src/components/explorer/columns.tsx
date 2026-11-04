import type { AuditEvent } from '@trailmark/contracts';
import { OutcomeDot, SeverityBadge, TypePill } from '@trailmark/ui/components/badges';
import { EntityChip } from '@trailmark/ui/components/entity-chip';
import { Tooltip, TooltipContent, TooltipTrigger } from '@trailmark/ui/components/ui/tooltip';
import { VenetianMaskIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { ActionName } from '@/components/action-name';
import { typeIcon } from '@/lib/entities';
import { eventSentence } from '@/lib/events';
import { formatFull, formatTimestamp } from '@/lib/format';

export interface EventColumn {
  id: string;
  label: string;
  /** Fixed width in px, or 'flex' for the one growing column. */
  width: number | 'flex';
  render: (e: AuditEvent) => ReactNode;
  defaultVisible: boolean;
  /** Cannot be hidden from the picker. */
  required?: boolean;
}

export const EVENT_COLUMNS: EventColumn[] = [
  {
    id: 'time',
    label: 'Time',
    width: 120,
    required: true,
    defaultVisible: true,
    render: (e) => (
      <Tooltip>
        <TooltipTrigger render={<span className="whitespace-nowrap font-mono text-[12px] text-muted-foreground tabular-nums" />}>
          {formatTimestamp(e.timestamp)}
        </TooltipTrigger>
        <TooltipContent>{formatFull(e.timestamp)}</TooltipContent>
      </Tooltip>
    ),
  },
  {
    id: 'outcome',
    label: 'Outcome',
    width: 86,
    defaultVisible: true,
    render: (e) => (
      <span className="flex items-center gap-1.5 text-[12px]">
        <OutcomeDot outcome={e.outcome} />
        <span className={e.outcome === 'success' ? 'text-muted-foreground' : 'font-medium'}>{e.outcome}</span>
      </span>
    ),
  },
  { id: 'action', label: 'Action', width: 210, defaultVisible: true, render: (e) => <ActionName action={e.action} /> },
  {
    id: 'description',
    label: 'Event',
    width: 'flex',
    required: true,
    defaultVisible: true,
    render: (e) => (
      <span className="flex min-w-0 items-center gap-1.5">
        {e.impersonator ? (
          <Tooltip>
            <TooltipTrigger render={<span className="shrink-0 text-outcome-denied" />}>
              <VenetianMaskIcon className="size-3.5" />
            </TooltipTrigger>
            <TooltipContent>Performed while {e.impersonator.name || e.impersonator.id} was impersonating</TooltipContent>
          </Tooltip>
        ) : null}
        {e.severity === 'critical' || e.severity === 'warning' ? (
          <SeverityBadge className="h-4 shrink-0 px-1.5 text-[10px]" severity={e.severity} />
        ) : null}
        <span className="truncate">{eventSentence(e)}</span>
      </span>
    ),
  },
  {
    id: 'actor',
    label: 'Actor',
    width: 156,
    defaultVisible: true,
    render: (e) =>
      e.actor ? (
        <EntityChip icon={e.actor.type === 'user' ? undefined : typeIcon('actor', e.actor.type)} id={e.actor.id} name={e.actor.name} />
      ) : (
        <span className="text-muted-foreground text-xs">—</span>
      ),
  },
  {
    id: 'tenant',
    label: 'Tenant',
    width: 150,
    defaultVisible: true,
    render: (e) =>
      e.tenant ? <EntityChip id={e.tenant.id} name={e.tenant.name} square /> : <span className="text-muted-foreground text-xs">—</span>,
  },
  {
    id: 'executor',
    label: 'Executor',
    width: 150,
    defaultVisible: false,
    render: (e) =>
      e.executor?.id ? (
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate font-mono text-[12px]">{e.executor.id}</span>
          {e.executor.attempt > 1 ? <TypePill tone="warning">#{e.executor.attempt}</TypePill> : null}
        </span>
      ) : (
        <span className="text-muted-foreground text-xs">—</span>
      ),
  },
  {
    id: 'targets',
    label: 'Targets',
    width: 180,
    defaultVisible: false,
    render: (e) =>
      e.targets.length ? (
        <span className="flex min-w-0 items-center gap-1.5">
          <TypePill>{e.targets[0]?.type}</TypePill>
          <span className="truncate">{e.targets[0]?.name || e.targets[0]?.id}</span>
          {e.targets.length > 1 ? <span className="shrink-0 text-muted-foreground text-xs">+{e.targets.length - 1}</span> : null}
        </span>
      ) : (
        <span className="text-muted-foreground text-xs">—</span>
      ),
  },
  { id: 'severity', label: 'Severity', width: 96, defaultVisible: false, render: (e) => <SeverityBadge severity={e.severity} /> },
  {
    id: 'environment',
    label: 'Environment',
    width: 110,
    defaultVisible: false,
    render: (e) => <span className="font-mono text-[12px]">{e.environment}</span>,
  },
  {
    id: 'source',
    label: 'Source',
    width: 116,
    defaultVisible: false,
    render: (e) => <span className="font-mono text-[12px]">{e.source ?? '—'}</span>,
  },
  {
    id: 'operation',
    label: 'Operation',
    width: 150,
    defaultVisible: false,
    render: (e) => <span className="truncate font-mono text-[12px] text-muted-foreground">{e.context.operationId || '—'}</span>,
  },
  {
    id: 'conformance',
    label: 'Conformance',
    width: 104,
    defaultVisible: false,
    render: (e) => (
      <span className="flex items-center gap-1.5">
        <span className="h-1 w-10 overflow-hidden rounded-full bg-muted">
          <span className="block h-full rounded-full bg-brand" style={{ width: `${e.conformance}%` }} />
        </span>
        <span className="text-muted-foreground text-xs tabular-nums">{e.conformance}%</span>
      </span>
    ),
  },
];

export const DEFAULT_COLUMNS = EVENT_COLUMNS.filter((c) => c.defaultVisible).map((c) => c.id);

export function parseColumns(cols: string | undefined): string[] {
  if (!cols) return DEFAULT_COLUMNS;
  const wanted = new Set(cols.split(',').filter(Boolean));
  for (const c of EVENT_COLUMNS) if (c.required) wanted.add(c.id);
  return EVENT_COLUMNS.filter((c) => wanted.has(c.id)).map((c) => c.id);
}

export function serializeColumns(ids: string[]): string | undefined {
  const same = ids.length === DEFAULT_COLUMNS.length && ids.every((id) => DEFAULT_COLUMNS.includes(id));
  return same ? undefined : ids.join(',');
}
