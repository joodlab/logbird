const MINUTE = 60_000;
/** Beyond this many minutes of disagreement the browser clock is not used at all. */
const MAX_SKEW_MINUTES = 120;

/**
 * The ingestion sparkline's one-minute buckets (#12). The server lists only the minutes that had events, so one event
 * gave a single point, which draws nothing: missing minutes are 0. Every bucket the server returned is on the line, so
 * the line always adds up to what "Last hour" counts: the window covers at least the 61 minutes up to now (the server's
 * lower bound, now - 60 min, is inclusive) and stretches to include any bucket outside them, whichever way this
 * browser's clock differs from the server's. A clock far off is ignored, and the window ends at the newest bucket.
 */
export function perMinuteSeries(points: readonly { ts: string; count: number }[], now = Date.now(), minutes = 61): number[] {
  const buckets = points.map((p) => ({ at: Math.floor(Date.parse(p.ts) / MINUTE), count: p.count })).filter((b) => Number.isFinite(b.at));
  const newest = Math.max(...buckets.map((b) => b.at));
  const oldest = Math.min(...buckets.map((b) => b.at));
  let end = Math.floor(now / MINUTE);
  if (buckets.length && (newest - end > MAX_SKEW_MINUTES || end - oldest > MAX_SKEW_MINUTES)) end = newest;
  end = buckets.length ? Math.max(end, newest) : end;
  const start = buckets.length ? Math.min(end - (minutes - 1), oldest) : end - (minutes - 1);
  const series = new Array<number>(end - start + 1).fill(0);
  for (const bucket of buckets) series[bucket.at - start] = (series[bucket.at - start] ?? 0) + bucket.count;
  return series;
}

/**
 * The failure-rate change in percentage points: undefined (no badge) when the current period has no events, since there
 * is no rate to compare; null ("new") when only the previous period had none (#12).
 */
export function rateChange(rate: number, events: number, previousRate: number, previousEvents: number): number | null | undefined {
  if (events === 0) return undefined;
  return previousEvents > 0 ? rate - previousRate : null;
}
