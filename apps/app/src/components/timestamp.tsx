import { Tooltip, TooltipContent, TooltipTrigger } from '@trailmark/ui/components/ui/tooltip';
import { cn } from '@trailmark/ui/lib/utils';
import { formatDate, formatFull, formatRelative, formatTimeMs, formatTimestamp, formatUtc } from '@/lib/format';

const FORMATS = {
  /** "14:32:10" today, "Nov 4, 14:32" otherwise. */
  table: formatTimestamp,
  /** "3 hours ago". */
  relative: (iso: string) => formatRelative(iso),
  /** "Nov 4, 2026". */
  date: formatDate,
  /** "Wed, Nov 4, 2026, 14:32:10 GMT+1". */
  full: formatFull,
  /** "14:32:10.123". */
  ms: formatTimeMs,
} as const;

/**
 * Every timestamp in the console renders in the viewer's local time zone; hovering shows the full
 * local time, the UTC instant and how long ago it was, so times can be compared across a team.
 */
export function Timestamp({
  iso,
  format = 'table',
  className,
  fallback = '—',
}: {
  iso: string | null | undefined;
  format?: keyof typeof FORMATS;
  className?: string;
  fallback?: string;
}) {
  if (!iso) return <span className={cn('text-muted-foreground', className)}>{fallback}</span>;
  return (
    <Tooltip>
      <TooltipTrigger render={<time className={cn('tabular-nums', className)} dateTime={iso} />}>{FORMATS[format](iso)}</TooltipTrigger>
      <TooltipContent className="flex-col items-start gap-0.5">
        <span>{formatFull(iso)}</span>
        <span className="font-mono text-[11px] opacity-70">{formatUtc(iso)}</span>
        <span className="opacity-70">{formatRelative(iso)}</span>
      </TooltipContent>
    </Tooltip>
  );
}
