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

const emptyRow = (ts: number): SeriesRow => ({ ts, total: 0, success: 0, partial: 0, denied: 0, failure: 0, unknown: 0 });

/**
 * Flatten histogram buckets; unrecognized outcomes fold into "unknown" (shown as Other).
 * The server only returns buckets that have events, so gaps (and the edges of `bounds`) are
 * zero-filled — otherwise areas would interpolate across quiet periods.
 */
export function toSeries(h: HistogramResponse | undefined, bounds?: { fromMs: number; toMs: number }): SeriesRow[] {
  if (!h) return [];
  const step = Math.max(1, h.interval) * 1000;
  const byTs = new Map<number, SeriesRow>();
  for (const b of h.buckets) {
    const ts = Date.parse(b.ts);
    const row = byTs.get(ts) ?? emptyRow(ts);
    row.total += b.total;
    for (const [outcome, count] of Object.entries(b.byOutcome)) {
      if ((SERIES as readonly string[]).includes(outcome)) row[outcome as SeriesKey] += count;
      else row.unknown += count;
    }
    byTs.set(ts, row);
  }
  const known = [...byTs.keys()].sort((x, y) => x - y);
  const first = bounds ? Math.floor(bounds.fromMs / step) * step : known[0];
  const last = bounds ? bounds.toMs - 1 : known.at(-1);
  if (first === undefined || last === undefined) return [];
  const rows: SeriesRow[] = [];
  // Guard against pathological ranges: never emit more than ~2000 buckets.
  if ((last - first) / step > 2000) return known.map((ts) => byTs.get(ts) ?? emptyRow(ts));
  for (let ts = first; ts <= last; ts += step) rows.push(byTs.get(ts) ?? emptyRow(ts));
  // Keep server buckets that are not aligned to our grid (different epoch alignment).
  for (const ts of known) if ((ts - first) % step !== 0) rows.push(byTs.get(ts) ?? emptyRow(ts));
  return rows.sort((x, y) => x.ts - y.ts);
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
