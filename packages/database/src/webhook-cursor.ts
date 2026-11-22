import type { Prisma, WebhookEndpoint } from './generated/client';

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

export function webhookCursorNeedsReview(
  endpoint: Pick<WebhookEndpoint, 'createdAt' | 'cursorReceivedAt' | 'cursorVerifiedFloor' | 'lastScannedAt'>,
  { now, rollout }: Awaited<ReturnType<typeof webhookCursorClock>>,
) {
  const start = Math.max(+endpoint.createdAt, +(endpoint.cursorVerifiedFloor ?? rollout));
  // Former workers recorded lastScannedAt before acquiring the watermark. Allow a minute for that gap.
  const scanLimit = endpoint.lastScannedAt ? +endpoint.lastScannedAt + 60_000 : start;
  const cursor = +endpoint.cursorReceivedAt;
  return cursor > +now || cursor < start || cursor > Math.max(start, scanLimit);
}
