import type { Prisma, WebhookEndpoint } from './generated/client';

export const CURSOR_START_TOLERANCE_MS = 60_000;

export async function webhookCursorClock(db: Pick<Prisma.TransactionClient, '$queryRaw'>) {
  const [clock] = await db.$queryRaw<{ now: Date; rollout: Date | null }[]>`
    SELECT clock_timestamp() AS now, (
      SELECT (started_at AT TIME ZONE 'UTC')::TIMESTAMP(3) FROM "_prisma_migrations"
      WHERE migration_name = '20261122140000_webhook_deliveries'
        AND finished_at IS NOT NULL AND rolled_back_at IS NULL
      ORDER BY started_at LIMIT 1
    ) AS rollout`;
  if (!clock?.rollout) throw new Error('Webhook delivery rollout time is unavailable');
  return { now: clock.now, rollout: clock.rollout };
}

export function webhookCursorStart(endpoint: Pick<WebhookEndpoint, 'createdAt' | 'cursorVerifiedFloor'>, rollout: Date) {
  return Math.max(+endpoint.createdAt, +(endpoint.cursorVerifiedFloor ?? rollout));
}

export function webhookCursorNeedsReview(
  endpoint: Pick<WebhookEndpoint, 'createdAt' | 'cursorReceivedAt' | 'cursorEventId' | 'cursorVerifiedFloor' | 'lastScannedAt'>,
  { now, rollout }: Awaited<ReturnType<typeof webhookCursorClock>>,
  hasEarlyDelivery = false,
) {
  if (endpoint.lastScannedAt === null && endpoint.cursorEventId !== null) return true;
  const start = webhookCursorStart(endpoint, rollout);
  // Former workers recorded lastScannedAt before acquiring the watermark. Allow a minute for that gap.
  const scanLimit = endpoint.lastScannedAt ? +endpoint.lastScannedAt + 60_000 : start;
  const cursor = +endpoint.cursorReceivedAt;
  if (cursor > +now || cursor > Math.max(start, scanLimit)) return true;
  if (cursor >= start) return false;
  if (endpoint.createdAt < (endpoint.cursorVerifiedFloor ?? rollout)) return true;
  if (cursor < start - CURSOR_START_TOLERANCE_MS) return true;
  // The old API's client-set creation time can follow the transaction's cursor default.
  // After any progress in that interval, require the delivery committed with the cursor.
  return endpoint.lastScannedAt !== null && (endpoint.cursorEventId === null || !hasEarlyDelivery);
}
