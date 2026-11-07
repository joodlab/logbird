import { cn } from '../lib/utils';

const OUTCOME_TONE: Record<string, { dot: string; badge: string }> = {
  success: { dot: 'bg-outcome-success', badge: 'text-outcome-success-foreground bg-outcome-success/10 ring-outcome-success/20' },
  failure: { dot: 'bg-outcome-failure', badge: 'text-outcome-failure-foreground bg-outcome-failure/10 ring-outcome-failure/25' },
  denied: { dot: 'bg-outcome-denied', badge: 'text-outcome-denied-foreground bg-outcome-denied/10 ring-outcome-denied/25' },
  partial: { dot: 'bg-outcome-partial', badge: 'text-outcome-partial-foreground bg-outcome-partial/10 ring-outcome-partial/25' },
  unknown: { dot: 'bg-outcome-unknown', badge: 'text-muted-foreground bg-muted ring-border' },
};
const NEUTRAL = { dot: 'bg-outcome-unknown', badge: 'text-muted-foreground bg-muted ring-border' };

/** CSS color for an outcome (charts). Unknown/custom outcomes render neutrally. */
export function outcomeColor(outcome: string): string {
  return OUTCOME_TONE[outcome] ? `var(--outcome-${outcome})` : 'var(--outcome-unknown)';
}

export function OutcomeDot({ outcome, className, pulse = false }: { outcome: string; className?: string; pulse?: boolean }) {
  const tone = OUTCOME_TONE[outcome] ?? NEUTRAL;
  return <span aria-hidden className={cn('inline-block size-2 shrink-0 rounded-full', tone.dot, pulse && 'tm-pulse-dot', className)} />;
}

export function OutcomeBadge({ outcome, className }: { outcome: string; className?: string }) {
  const tone = OUTCOME_TONE[outcome] ?? NEUTRAL;
  return (
    <span className={cn('inline-flex h-5 items-center gap-1.5 rounded-full px-2 font-medium text-[11px] ring-1 ring-inset', tone.badge, className)}>
      <span className={cn('size-1.5 rounded-full', tone.dot)} />
      {outcome || 'unknown'}
    </span>
  );
}

const SEVERITY_TONE: Record<string, string> = {
  info: 'text-muted-foreground bg-muted ring-border',
  notice: 'text-severity-notice-foreground bg-severity-notice/10 ring-severity-notice/20',
  warning: 'text-severity-warning-foreground bg-severity-warning/10 ring-severity-warning/25',
  critical: 'text-white bg-severity-critical ring-severity-critical dark:text-black',
};

export function SeverityBadge({ severity, className, hideInfo = false }: { severity: string; className?: string; hideInfo?: boolean }) {
  if (hideInfo && severity === 'info') return null;
  return (
    <span
      className={cn(
        'inline-flex h-5 items-center rounded-full px-2 font-medium text-[11px] ring-1 ring-inset',
        SEVERITY_TONE[severity] ?? SEVERITY_TONE.info,
        severity === 'critical' && 'uppercase tracking-wide',
        className,
      )}
    >
      {severity || 'info'}
    </span>
  );
}

/** Small mono pill for kinds/types: "ingest", "worker", "hotel". */
export function TypePill({
  children,
  className,
  tone = 'neutral',
}: {
  children: React.ReactNode;
  className?: string;
  tone?: 'neutral' | 'brand' | 'warning';
}) {
  return (
    <span
      className={cn(
        'inline-flex h-5 items-center gap-1 whitespace-nowrap rounded-md px-1.5 font-mono text-[11px] ring-1 ring-inset',
        tone === 'neutral' && 'bg-muted text-muted-foreground ring-border',
        tone === 'brand' && 'bg-brand/10 text-brand ring-brand/20',
        tone === 'warning' && 'bg-outcome-denied/10 text-outcome-denied-foreground ring-outcome-denied/25',
        className,
      )}
    >
      {children}
    </span>
  );
}
