import type { AuditEvent } from '@logbird/contracts';
import { TypePill } from '@logbird/ui/components/badges';
import { cn } from '@logbird/ui/lib/utils';
import { Link } from '@tanstack/react-router';
import { CogIcon, VenetianMaskIcon } from 'lucide-react';
import { createContext, type ReactNode, useContext } from 'react';
import { personLabel } from '@/lib/events';
import { jobHint, supportAgentName, supportMarkerPlacement, supportPhrase } from '@/lib/impersonation';

/**
 * What row cells need to know about their list without threading props through column defs: the project (to link)
 * and which columns are showing (so the support marker appears once, in the best place). The explorer provides it
 * around its table, so the table itself stays unaware of support.
 */
export const EventListContext = createContext<{ projectId?: string; columns?: readonly string[] }>({});

/**
 * Link to a support agent's page: everything they did while signed in as customers. Clicks and keys stay on the link,
 * so Enter on it never also opens the row's event sheet.
 */
export function SupportAgentLink({
  projectId,
  agentId,
  className,
  children,
  tabIndex,
  title,
  'aria-label': ariaLabel,
}: {
  projectId: string;
  agentId: string;
  className?: string;
  children: ReactNode;
  /** -1 inside list rows: the row is the tab stop; the agent page is one step away via the event sheet. */
  tabIndex?: number;
  title?: string;
  'aria-label'?: string;
}) {
  return (
    <Link
      aria-label={ariaLabel}
      className={className}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
      params={{ projectId, agentId }}
      tabIndex={tabIndex}
      title={title}
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
export function SupportMarker({
  event,
  className,
  linked = true,
  variant = 'pill',
}: {
  event: AuditEvent;
  className?: string;
  linked?: boolean;
  /** `inline`: a quiet second line under the actor's name. */
  variant?: 'pill' | 'inline';
}) {
  const { projectId } = useContext(EventListContext);
  const name = supportAgentName(event);
  const phrase = supportPhrase(event);
  if (!event.impersonator || !name || !phrase) return null;
  const description = phrase.charAt(0).toUpperCase() + phrase.slice(1);
  const content = (
    <>
      <VenetianMaskIcon aria-hidden className="size-3 shrink-0 text-support" />
      <span className="truncate">
        <span className="text-support-foreground">via support:</span> <bdi className="font-medium text-foreground">{name}</bdi>
      </span>
    </>
  );
  // The pill is the shared support-toned TypePill (sans, not mono: it carries a person's name).
  const body =
    variant === 'inline' ? (
      <span className={cn('inline-flex h-3.5 min-w-0 max-w-full items-center gap-1 rounded-sm text-[10.5px] leading-none', className)}>
        {content}
      </span>
    ) : (
      <TypePill className={cn('min-w-0 max-w-[13rem] shrink-0 font-sans', className)} tone="support">
        {content}
      </TypePill>
    );
  if (linked && projectId) {
    return (
      // The name starts with the visible "via support: X" (WCAG 2.5.3), then says as whom and where the link goes.
      <SupportAgentLink
        agentId={event.impersonator.id}
        className={cn(
          'inline-flex max-w-full rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
          // The pill never shrinks below its own width inside a tight row (m1): the neighbouring action truncates instead.
          variant === 'inline' ? 'min-w-0 hover:underline hover:underline-offset-2' : 'shrink-0 hover:brightness-95 dark:hover:brightness-125',
        )}
        projectId={projectId}
        tabIndex={-1}
        title={description}
      >
        {body}
        <span className="sr-only">
          , acting as <bdi>{personLabel(event.actor) || 'an unknown customer'}</bdi>. Opens their support activity
        </span>
      </SupportAgentLink>
    );
  }
  return (
    <span className={cn('inline-flex max-w-full', variant === 'inline' ? 'min-w-0' : 'shrink-0')} title={description}>
      {body}
      <span className="sr-only">, acting as {personLabel(event.actor) || 'an unknown customer'}</span>
    </span>
  );
}

/** "⚙ try 2": which job ran it and which attempt (in the tooltip and for screen readers), for background-job rows. */
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
  // Desktop: a cog marks a background job; only a retry spells out its try, so retries stand out in a dense list.
  return (
    <span className={cn('inline-flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground', className)} title={hint.label}>
      <CogIcon aria-hidden className="size-3 shrink-0" />
      {retry ? (
        <span aria-hidden className="font-semibold text-foreground">
          try {hint.attempt}
        </span>
      ) : null}
      <span className="sr-only">{hint.label}</span>
    </span>
  );
}

/** The support marker, shown only where {@link supportMarkerPlacement} puts it for the visible columns. */
export function PlacedSupportMarker({
  placement,
  ...props
}: Parameters<typeof SupportMarker>[0] & { placement: ReturnType<typeof supportMarkerPlacement> }) {
  const { columns } = useContext(EventListContext);
  return supportMarkerPlacement(columns) === placement ? <SupportMarker {...props} /> : null;
}
