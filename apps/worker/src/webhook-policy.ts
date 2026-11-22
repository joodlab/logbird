import { ASYNC_INSERT_FLUSH_BOUND_MS } from '@logbird/clickhouse';

export const RETRY_WINDOW_MS = 86_400_000;
const SCHEDULE_MS = [5000, 30_000, 120_000, 600_000, 1_800_000, 3_600_000];
const WATERMARK_MARGIN_MS = 5000;

export function webhookWatermark(now: Date, pending: Date | null) {
  // ClickHouse's receive clock has millisecond precision. The pending millisecond itself is unsafe:
  // another event at that time can already be visible with a larger event id.
  return new Date(Math.min(+now - ASYNC_INSERT_FLUSH_BOUND_MS - WATERMARK_MARGIN_MS, pending ? +pending - 1 : Number.POSITIVE_INFINITY));
}

export function webhookRetryDelay(attempt: number, random = Math.random()) {
  const base = SCHEDULE_MS[attempt - 1];
  if (base !== undefined) return Math.round(base * (0.8 + random * 0.4));
  return Math.round((2 + random * 2) * 3_600_000);
}
