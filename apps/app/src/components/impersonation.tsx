import type { AuditEvent } from '@logbird/contracts';
import { cn } from '@logbird/ui/lib/utils';
import { Link } from '@tanstack/react-router';
import { CogIcon, VenetianMaskIcon } from 'lucide-react';
import { createContext, type ReactNode, useContext } from 'react';
import { personLabel } from '@/lib/events';
import { jobHint, supportAgentName } from '@/lib/impersonation';

/** The project a list of events belongs to, so row cells can link without threading props through column defs. */
export const EventListProjectContext = createContext<string | undefined>(undefined);

/** Link to a support agent's page: everything they did while acting as customers. */
export function SupportAgentLink({
  projectId,
  agentId,
  className,
  children,
  'aria-label': ariaLabel,
}: {
  projectId: string;
  agentId: string;
  className?: string;
  children: ReactNode;
  'aria-label'?: string;
}) {
  return (
    <Link
      aria-label={ariaLabel}
      className={className}
      onClick={(e) => e.stopPropagation()}
      params={{ projectId, agentId }}
      to="/p/$projectId/support/$agentId"
    >
      {children}
    </Link>
  );
}

/**
 * "via support: Hana Calder" — a labelled, readable marker for impersonated events. Text, not just an icon, so it
 * reads on phones and to screen readers; links to the agent's page when the list knows its project.
 */
export function SupportMarker({ event, className, linked = true }: { event: AuditEvent; className?: string; linked?: boolean }) {
  const projectId = useContext(EventListProjectContext);
  const name = supportAgentName(event);
  if (!event.impersonator || !name) return null;
  const actingAs = personLabel(event.actor) || 'the customer';
  const description = `Done by support agent ${name} while acting as ${actingAs}`;
  const pill = cn(
    'inline-flex h-5 max-w-[13rem] shrink-0 items-center gap-1 rounded-md bg-outcome-denied/10 px-1.5 text-[11px] text-foreground ring-1 ring-outcome-denied/30 ring-inset',
    className,
  );
  const content = (
    <>
      <VenetianMaskIcon aria-hidden className="size-3 shrink-0 text-outcome-denied" />
      <span className="truncate" dir="auto">
        <span className="text-muted-foreground">via support:</span> <span className="font-medium">{name}</span>
      </span>
    </>
  );
  if (linked && projectId) {
    return (
      <SupportAgentLink
        aria-label={`${description}. Open ${name}'s support activity`}
        agentId={event.impersonator.id}
        className={cn(pill, 'outline-none hover:bg-outcome-denied/15 focus-visible:ring-2 focus-visible:ring-ring/50')}
        projectId={projectId}
      >
        {content}
      </SupportAgentLink>
    );
  }
  return (
    <span className={pill} title={description}>
      {content}
      <span className="sr-only">, acting as {actingAs}</span>
    </span>
  );
}

/** "⚙ billing-worker · try 2": which job ran it and which attempt, for rows that came from a background job. */
export function JobHint({ event, className, compact = false }: { event: AuditEvent; className?: string; compact?: boolean }) {
  const hint = jobHint(event);
  if (!hint) return null;
  const retry = hint.attempt > 1;
  if (compact) {
    // Phones: only a retry is worth the space.
    return retry ? (
      <span className={cn('shrink-0 font-semibold text-[11px] text-foreground', className)} title={hint.label}>
        <span aria-hidden>try {hint.attempt}</span>
        <span className="sr-only">{hint.label}</span>
      </span>
    ) : null;
  }
  return (
    <span className={cn('inline-flex min-w-0 shrink items-center gap-1 text-[11px] text-muted-foreground', className)} title={hint.label}>
      <CogIcon aria-hidden className="size-3 shrink-0" />
      <span aria-hidden className="truncate font-mono">
        {hint.executor}
      </span>
      {hint.attempt > 0 ? (
        <span aria-hidden className={cn('shrink-0', retry && 'font-semibold text-foreground')}>
          · try {hint.attempt}
        </span>
      ) : null}
      <span className="sr-only">{hint.label}</span>
    </span>
  );
}
