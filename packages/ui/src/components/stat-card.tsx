import { ArrowDownRightIcon, ArrowUpRightIcon, MinusIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../lib/utils';
import { Skeleton } from './ui/skeleton';

interface StatCardProps {
  label: string;
  value: ReactNode;
  /** Relative change vs. the previous window (0.12 = +12%). null = no baseline. */
  delta?: number | null;
  /** Whether an increase is good (events, conformance) or bad (failure rate). */
  goodWhen?: 'up' | 'down' | 'neutral';
  /** `relative`: delta is a ratio (+12%). `points`: delta is an absolute change of a rate (+0.4 pp). */
  deltaKind?: 'relative' | 'points';
  hint?: ReactNode;
  footer?: ReactNode;
  loading?: boolean;
  className?: string;
  onClick?: () => void;
}

const pct = new Intl.NumberFormat('en-US', { style: 'percent', maximumFractionDigits: 1, signDisplay: 'exceptZero' });
const points = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1, signDisplay: 'exceptZero' });

export function DeltaBadge({
  delta,
  goodWhen = 'up',
  kind = 'relative',
}: {
  delta: number | null | undefined;
  goodWhen?: 'up' | 'down' | 'neutral';
  kind?: 'relative' | 'points';
}) {
  if (delta === undefined) return null;
  if (delta === null) return <span className="text-muted-foreground text-xs">new</span>;
  const flat = Math.abs(delta) < (kind === 'points' ? 0.0005 : 0.005);
  const up = delta > 0;
  const good = goodWhen === 'neutral' || flat ? null : (up && goodWhen === 'up') || (!up && goodWhen === 'down');
  const Icon = flat ? MinusIcon : up ? ArrowUpRightIcon : ArrowDownRightIcon;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-0.5 rounded-md px-1 py-0.5 font-medium text-xs tabular-nums',
        good === null && 'text-muted-foreground',
        good === true && 'bg-outcome-success/10 text-outcome-success',
        good === false && 'bg-outcome-failure/10 text-outcome-failure',
      )}
      title={
        kind === 'points'
          ? 'Change in percentage points versus the previous window of the same length'
          : 'Compared with the previous window of the same length'
      }
    >
      <Icon className="size-3" />
      {kind === 'points' ? `${flat ? '0' : points.format(delta * 100)} pp` : flat ? '0%' : pct.format(delta)}
    </span>
  );
}

export function StatCard({ label, value, delta, goodWhen = 'up', deltaKind, hint, footer, loading, className, onClick }: StatCardProps) {
  const Comp = onClick ? 'button' : 'div';
  return (
    <Comp
      className={cn(
        'flex min-w-0 flex-col gap-2 rounded-xl border bg-card p-4 text-start shadow-xs outline-none',
        onClick && 'transition-colors hover:border-foreground/20 focus-visible:ring-3 focus-visible:ring-ring/40',
        className,
      )}
      onClick={onClick}
      type={onClick ? 'button' : undefined}
    >
      {/* Fixed-height header so values line up whether or not a card has a delta badge. */}
      <div className="flex h-5 items-center justify-between gap-2">
        <span className="truncate text-muted-foreground text-xs">{label}</span>
        {loading ? null : <DeltaBadge delta={delta} goodWhen={goodWhen} kind={deltaKind} />}
      </div>
      {loading ? <Skeleton className="h-7 w-24" /> : <div className="font-semibold text-2xl tabular-nums tracking-tight">{value}</div>}
      {hint ? <div className="text-muted-foreground text-xs">{hint}</div> : null}
      {footer}
    </Comp>
  );
}
