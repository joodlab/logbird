/**
 * The ingestion sparkline's one-minute buckets (#12). The server lists only the minutes that had events, so one event
 * gave a single point, which draws nothing: missing minutes are 0. The window ends at the later of this browser's
 * current minute and the newest bucket the server returned (a browser clock a little behind, or an event stamped ahead,
 * must not drop it), and spans 61 minutes, because the server's lower bound (now - 60 min) is inclusive: every bucket
 * behind "Last hour" stays on the line.
 */
export function perMinuteSeries(points: readonly { ts: string; count: number }[], now = Date.now(), minutes = 61): number[] {
  const MINUTE = 60_000;
  const stamps = points.map((p) => Math.floor(Date.parse(p.ts) / MINUTE)).filter(Number.isFinite);
  const last = Math.max(Math.floor(now / MINUTE), ...stamps);
  const series = new Array<number>(minutes).fill(0);
  for (const point of points) {
    const at = Math.floor(Date.parse(point.ts) / MINUTE);
    if (!Number.isFinite(at)) continue;
    const index = minutes - 1 - (last - at);
    if (index >= 0) series[index] = (series[index] ?? 0) + point.count;
  }
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
