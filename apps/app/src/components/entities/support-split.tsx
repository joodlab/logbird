import type { EntityKind } from '@logbird/contracts';
import { EntityAvatar } from '@logbird/ui/components/entity-chip';
import { Panel } from '@logbird/ui/components/page-header';
import { SegmentedControl, SegmentedControlItem } from '@logbird/ui/components/ui/segmented-control';
import { cn } from '@logbird/ui/lib/utils';
import { useQuery } from '@tanstack/react-query';
import { ArrowRightIcon, UserIcon, VenetianMaskIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { SupportAgentLink } from '@/components/impersonation';
import { facetQuery } from '@/lib/api/queries';
import { formatNumber } from '@/lib/format';
import { supportAgentQuery, type WhoFilter } from '@/lib/impersonation';

export interface SupportCounts {
  /** Events in range that support did (as this actor / in this tenant / on this record). */
  support: number;
  agents: { id: string; name: string; count: number }[];
  /** Actors only: what this person did as a support agent, acting as others. */
  asAgent: number;
}

/** Support activity around one entity: who from support was involved, and what this actor did as support. */
export function useSupportCounts(projectId: string, kind: EntityKind, entityId: string, baseQuery: string, range: string): SupportCounts | undefined {
  const agents = useQuery(facetQuery(projectId, 'impersonator', range, baseQuery, 20));
  const asAgent = useQuery({ ...facetQuery(projectId, 'impersonator', range, supportAgentQuery(entityId), 1), enabled: kind === 'actor' });
  if (!agents.data || agents.isPlaceholderData) return undefined;
  const present = agents.data.values.filter((v) => v.value !== '');
  return {
    support: present.reduce((n, v) => n + v.count, 0) + agents.data.otherCount,
    agents: present.map((v) => ({ id: v.value, name: v.label || v.value, count: v.count })),
    asAgent: kind === 'actor' && asAgent.data && !asAgent.isPlaceholderData ? (asAgent.data.values[0]?.count ?? 0) : 0,
  };
}

const SPLIT_COPY = {
  actor: { self: 'Acted themselves', support: 'Support acting as them' },
  other: { self: 'Not by support', support: 'Done by support' },
} as const;

export function splitCopy(kind: EntityKind) {
  return kind === 'actor' ? SPLIT_COPY.actor : SPLIT_COPY.other;
}

/**
 * "Acted themselves 120 · Support acting as them 11", the support agents involved, and (for an actor who is also a
 * support agent) a way to their impersonation activity. Clicking a number filters the timeline.
 */
export function SupportSplitPanel({
  projectId,
  kind,
  entityId,
  name,
  total,
  counts,
  who,
  onWho,
}: {
  projectId: string;
  kind: EntityKind;
  entityId: string;
  name: string;
  /** Every event in range for this entity. */
  total: number | undefined;
  counts: SupportCounts | undefined;
  who: WhoFilter;
  onWho: (who: WhoFilter) => void;
}) {
  // Nothing while loading: most entities never involve support, so no placeholder that then vanishes.
  if (!counts || total === undefined) return null;
  if (counts.support === 0 && counts.asAgent === 0) return null;
  const copy = splitCopy(kind);
  const self = Math.max(total - counts.support, 0);
  return (
    <Panel
      description={
        kind === 'actor'
          ? `Some of these events were done by a support agent signed in as ${name}.`
          : 'Some of these events were done by a support agent acting as a customer.'
      }
      title="Who did it"
    >
      <div className="flex flex-col gap-3 p-3">
        {counts.support > 0 ? (
          <div className="grid grid-cols-2 gap-2">
            <SplitButton
              active={who === 'self'}
              count={self}
              icon={<UserIcon className="size-3.5" />}
              label={copy.self}
              onClick={() => onWho(who === 'self' ? 'all' : 'self')}
            />
            <SplitButton
              active={who === 'support'}
              count={counts.support}
              icon={<VenetianMaskIcon className="size-3.5 text-outcome-denied" />}
              label={copy.support}
              onClick={() => onWho(who === 'support' ? 'all' : 'support')}
            />
          </div>
        ) : null}
        {counts.agents.length > 0 ? (
          <div className="flex flex-col gap-1">
            <span className="px-1 text-[11px] text-muted-foreground uppercase tracking-wider">Support agents</span>
            <ul className="grid gap-px sm:grid-cols-2 lg:grid-cols-3">
              {counts.agents.slice(0, 6).map((a) => (
                <li key={a.id}>
                  <SupportAgentLink
                    aria-label={`${a.name}, support agent: ${formatNumber(a.count)} events. Open their support activity`}
                    agentId={a.id}
                    className="flex min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-[13px] outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring/50"
                    projectId={projectId}
                  >
                    <EntityAvatar id={a.id} name={a.name} size="sm" />
                    <span className="min-w-0 flex-1 truncate" dir="auto">
                      {a.name}
                    </span>
                    <span className="text-muted-foreground text-xs tabular-nums">{formatNumber(a.count)}</span>
                  </SupportAgentLink>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {counts.asAgent > 0 ? (
          <SupportAgentLink
            agentId={entityId}
            className="flex items-center gap-2 rounded-md border border-outcome-denied/25 bg-outcome-denied/5 px-3 py-2 text-[13px] outline-none hover:bg-outcome-denied/10 focus-visible:ring-2 focus-visible:ring-ring/50"
            projectId={projectId}
          >
            <VenetianMaskIcon aria-hidden className="size-4 shrink-0 text-outcome-denied" />
            <span className="min-w-0 flex-1">
              {name} is also a support agent: <span className="font-medium">{formatNumber(counts.asAgent)}</span> action
              {counts.asAgent === 1 ? '' : 's'} while acting as other people. These are not counted here.
            </span>
            <ArrowRightIcon aria-hidden className="size-4 shrink-0" />
          </SupportAgentLink>
        ) : null}
      </div>
    </Panel>
  );
}

function SplitButton({
  label,
  count,
  icon,
  active,
  onClick,
}: {
  label: string;
  count: number;
  icon: ReactNode;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      aria-pressed={active}
      className={cn(
        'flex min-w-0 flex-col gap-0.5 rounded-lg border px-3 py-2 text-start outline-none transition-colors hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring/50',
        active && 'border-brand/40 bg-brand/[0.06]',
      )}
      onClick={onClick}
      type="button"
    >
      <span className="flex items-center gap-1.5 text-muted-foreground text-xs">
        {icon}
        <span className="truncate">{label}</span>
      </span>
      <span className="font-semibold text-lg tabular-nums tracking-tight">{formatNumber(count)}</span>
    </button>
  );
}

/** Timeline control: Everything · Acted themselves · Support acting as them. */
export function WhoSegmentedControl({
  kind,
  who,
  onWho,
  className,
}: {
  kind: EntityKind;
  who: WhoFilter;
  onWho: (who: WhoFilter) => void;
  className?: string;
}) {
  const copy = splitCopy(kind);
  return (
    <SegmentedControl aria-label="Who did it" className={className} size="sm">
      <SegmentedControlItem active={who === 'all'} onClick={() => onWho('all')}>
        Everything
      </SegmentedControlItem>
      <SegmentedControlItem active={who === 'self'} onClick={() => onWho('self')}>
        {copy.self}
      </SegmentedControlItem>
      <SegmentedControlItem active={who === 'support'} onClick={() => onWho('support')}>
        <VenetianMaskIcon aria-hidden className="text-outcome-denied" />
        {copy.support}
      </SegmentedControlItem>
    </SegmentedControl>
  );
}
