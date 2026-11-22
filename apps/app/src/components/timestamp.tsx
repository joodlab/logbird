import { Tooltip, TooltipContent, TooltipTrigger } from '@logbird/ui/components/ui/tooltip';
import { cn } from '@logbird/ui/lib/utils';
import { displayTimeZone, formatDate, formatFull, formatInZone, formatRelative, formatTimeMs, formatTimestamp, formatUtc } from '@/lib/format';
import { BROWSER_ZONE } from '@/lib/time-zone';

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
 * Every timestamp in the console renders in the console zone (the browser's, or UTC when chosen); hovering shows the
 * full time with its zone, the UTC instant, the local time in UTC mode, and how long ago it was.
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
        {/* Both zones, whichever the console shows: the UTC instant (as in exports) and, in UTC mode, the local time. */}
        <span className="font-mono text-[11px] opacity-70">{formatUtc(iso)}</span>
        {displayTimeZone() === 'UTC' && BROWSER_ZONE !== 'UTC' ? <span className="opacity-70">{formatInZone(iso, BROWSER_ZONE)}</span> : null}
        <span className="opacity-70">{formatRelative(iso)}</span>
      </TooltipContent>
    </Tooltip>
  );
}
