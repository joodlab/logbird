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

export function tickFormatter(intervalSeconds: number) {
  return (ts: number) => (intervalSeconds >= 86_400 ? dayFmt.format(ts) : intervalSeconds >= 3600 ? fullFmt.format(ts) : hourFmt.format(ts));
}

export function bucketLabel(ts: number, intervalSeconds: number): string {
  const end = ts + intervalSeconds * 1000;
  if (intervalSeconds >= 86_400) return dayFmt.format(ts);
  return `${fullFmt.format(ts)} – ${hourFmt.format(end)}`;
}
