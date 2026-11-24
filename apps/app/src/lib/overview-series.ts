/**
 * The ingestion sparkline's 60 one-minute buckets, ending with the current minute. The server lists only the minutes
 * that had events, so a project with one event got a single point, which draws nothing (#12): missing minutes are 0.
 */
export function perMinuteSeries(points: readonly { ts: string; count: number }[], now = Date.now(), minutes = 60): number[] {
  const MINUTE = 60_000;
  const last = Math.floor(now / MINUTE);
  const series = new Array<number>(minutes).fill(0);
  for (const point of points) {
    const at = Date.parse(point.ts);
    if (!Number.isFinite(at)) continue;
    const index = minutes - 1 - (last - Math.floor(at / MINUTE));
    if (index >= 0 && index < minutes) series[index] = (series[index] ?? 0) + point.count;
  }
  return series;
}

/**
 * The failure-rate change in percentage points, or null ("new") when the previous period had no events: a rate
 * against an empty period is not a change (#12), the same way Events and Actors say "new".
 */
export function rateChange(rate: number, previousRate: number, previousEvents: number): number | null {
  return previousEvents > 0 ? rate - previousRate : null;
}
