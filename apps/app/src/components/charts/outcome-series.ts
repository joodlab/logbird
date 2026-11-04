import type { HistogramResponse } from '@trailmark/contracts';
import type { ChartConfig } from '@trailmark/ui/components/ui/chart';
import { formatClock, formatDayTime, formatMonthDay, zoneOffsetMs } from '@/lib/format';

export const SERIES = ['success', 'partial', 'denied', 'failure', 'unknown'] as const;
export type SeriesKey = (typeof SERIES)[number];

export const outcomeChartConfig = {
  success: { label: 'Success', color: 'var(--outcome-success)' },
  partial: { label: 'Partial', color: 'var(--outcome-partial)' },
  denied: { label: 'Denied', color: 'var(--outcome-denied)' },
  failure: { label: 'Failure', color: 'var(--outcome-failure)' },
  unknown: { label: 'Other', color: 'var(--outcome-unknown)' },
} satisfies ChartConfig;

export interface SeriesRow {
  ts: number;
  total: number;
  success: number;
  partial: number;
  denied: number;
  failure: number;
  unknown: number;
}

/**
 * Flatten histogram buckets; unrecognized outcomes fold into "unknown" (shown as Other).
 * The server returns every bucket in the range, zero-filled, so quiet periods stay flat.
 */
export function toSeries(h: HistogramResponse | undefined): SeriesRow[] {
  if (!h) return [];
  return h.buckets.map((b) => {
    const row: SeriesRow = { ts: Date.parse(b.ts), total: b.total, success: 0, partial: 0, denied: 0, failure: 0, unknown: 0 };
    for (const [outcome, count] of Object.entries(b.byOutcome)) {
      if ((SERIES as readonly string[]).includes(outcome)) row[outcome as SeriesKey] += count;
      else row.unknown += count;
    }
    return row;
  });
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const NICE_STEPS = [
  MINUTE,
  5 * MINUTE,
  10 * MINUTE,
  15 * MINUTE,
  30 * MINUTE,
  HOUR,
  2 * HOUR,
  3 * HOUR,
  6 * HOUR,
  12 * HOUR,
  DAY,
  2 * DAY,
  7 * DAY,
  14 * DAY,
  30 * DAY,
];

/** Offset that turns a UTC instant into console-zone wall-clock ms, so ticks land on local hours and midnights. */
const localOffset = zoneOffsetMs;

/**
 * Axis ticks for server buckets. The server picks bucket sizes from a round ladder (1m…1d) aligned to UTC
 * multiples, so every tick is a bucket start: bars and area points sit exactly on their labels. Ticks prefer
 * round *local* boundaries (00:00, 06:00, Nov 5…); zones with a sub-hour offset fall back to round UTC ones.
 */
export function timeTicks(rows: SeriesRow[], intervalSeconds: number, target = 7) {
  const step = Math.max(1, intervalSeconds) * 1000;
  const first = rows[0]?.ts;
  const last = rows.at(-1)?.ts;
  if (first === undefined || last === undefined || last <= first) return { ticks: undefined, format: (ts: number) => formatClock(ts) };
  const span = last + step - first;
  const nice = NICE_STEPS.find((n) => n >= step && n % step === 0 && span / n <= target) ?? Math.max(step, NICE_STEPS.at(-1) ?? DAY);
  // Labels are centered on their tick: keep them clear of the plot edges so none is clipped.
  const edge = span * 0.035;
  const inside = (r: SeriesRow) => r.ts >= first + edge && r.ts <= last + step - edge;
  let ticks = rows.filter((r) => inside(r) && (r.ts + localOffset(r.ts)) % nice === 0).map((r) => r.ts);
  if (ticks.length < 2) ticks = rows.filter((r) => inside(r) && r.ts % nice === 0).map((r) => r.ts);
  const multiDay = span > DAY;
  const format = (ts: number) => {
    const midnight = (ts + localOffset(ts)) % DAY === 0;
    return nice >= DAY || (multiDay && midnight) ? formatMonthDay(ts) : formatClock(ts);
  };
  return { ticks, format };
}

/** Bars tick on bucket starts too; kept as its own name for the category axis. */
export const bucketTicks = (rows: SeriesRow[], intervalSeconds: number) => timeTicks(rows, intervalSeconds);

export function bucketLabel(ts: number, intervalSeconds: number): string {
  const end = ts + intervalSeconds * 1000;
  if (intervalSeconds >= 86_400) return formatMonthDay(ts);
  return `${formatDayTime(ts)} – ${formatClock(end)}`;
}
