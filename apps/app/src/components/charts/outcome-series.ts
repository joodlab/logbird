import type { HistogramResponse } from '@trailmark/contracts';
import type { ChartConfig } from '@trailmark/ui/components/ui/chart';

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

const hourFmt = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
const dayFmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });
const fullFmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });

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

/** Offset that turns a UTC instant into local wall-clock ms, so ticks land on local hours and midnights. */
const localOffset = (ts: number) => -new Date(ts).getTimezoneOffset() * MINUTE;

/**
 * Axis ticks on round *local* boundaries (00:00, 03:00, Nov 5…), whatever bucket size the server chose.
 * Server buckets are epoch-aligned (e.g. 24 min), so labelling the buckets themselves gives 03:48, 06:36….
 */
export function timeTicks(rows: SeriesRow[], intervalSeconds: number, target = 7) {
  const step = Math.max(1, intervalSeconds) * 1000;
  const first = rows[0]?.ts;
  const last = rows.at(-1)?.ts;
  if (first === undefined || last === undefined || last <= first) return { ticks: undefined, format: (ts: number) => hourFmt.format(ts) };
  const span = last + step - first;
  const nice = NICE_STEPS.find((n) => n >= step && span / n <= target) ?? NICE_STEPS.at(-1) ?? DAY;
  const boundaries: number[] = [];
  for (let b = Math.ceil((first + localOffset(first)) / nice) * nice; b - localOffset(b) <= last + step; b += nice)
    boundaries.push(b - localOffset(b));
  // Labels are centered on their tick: keep them clear of the plot edges so none is clipped.
  const edge = span * 0.035;
  const inside = boundaries.filter((b) => b >= first + edge && b <= last + step - edge);
  const multiDay = span > DAY;
  const format = (ts: number) => {
    const midnight = (ts + localOffset(ts)) % DAY === 0;
    return nice >= DAY || (multiDay && midnight) ? dayFmt.format(ts) : hourFmt.format(ts);
  };
  return { ticks: inside, format };
}

/** Category axes (bars) can only tick on bucket starts: map each boundary to the bucket containing it. */
export function bucketTicks(rows: SeriesRow[], intervalSeconds: number) {
  const { ticks, format } = timeTicks(rows, intervalSeconds);
  if (!ticks) return { ticks: undefined, format };
  const step = Math.max(1, intervalSeconds) * 1000;
  const labelFor = new Map<number, number>();
  for (const b of ticks) {
    const row = rows.find((r) => b >= r.ts && b < r.ts + step);
    if (row && !labelFor.has(row.ts)) labelFor.set(row.ts, b);
  }
  return { ticks: [...labelFor.keys()], format: (ts: number) => format(labelFor.get(ts) ?? ts) };
}

export function bucketLabel(ts: number, intervalSeconds: number): string {
  const end = ts + intervalSeconds * 1000;
  if (intervalSeconds >= 86_400) return dayFmt.format(ts);
  return `${fullFmt.format(ts)} – ${hourFmt.format(end)}`;
}
