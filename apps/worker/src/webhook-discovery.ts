import {
  type ClickHouseClient,
  compileMaskedQuery,
  type EventRow,
  OCCURRED_AT_FUTURE_DAYS,
  OCCURRED_AT_PAST_DAYS,
  read,
  toEvent,
} from '@logbird/clickhouse';
import { storedWebhookScope, type WebhookScope } from '@logbird/contracts';
import { prisma, type WebhookEndpoint, withIngestReceiptGate } from '@logbird/database';
import { WEBHOOK_LOG_RETENTION_MS, webhookCursorClock, webhookCursorNeedsReview } from '@logbird/database/webhooks';
import { webhookWatermark } from './webhook-policy';

const DISCOVERY_PAGE_SIZE = 100;
const DISCOVERY_SLICE_MS = 5 * 60_000;
// A self-hosted ClickHouse profile may normally return partial reads on overflow. Never commit those to the cursor.
const COMPLETE_READ = `SETTINGS read_overflow_mode = 'throw', read_overflow_mode_leaf = 'throw', result_overflow_mode = 'throw',
  timeout_overflow_mode = 'throw', timeout_overflow_mode_leaf = 'throw', group_by_overflow_mode = 'throw', sort_overflow_mode = 'throw'`;
type EndpointFilter = Pick<WebhookEndpoint, 'projectId' | 'filterQuery'>;

function scopePredicate(endpoint: EndpointFilter, scope: WebhookScope | null, clock: number) {
  const filter = compileMaskedQuery(endpoint.filterQuery, scope?.mask, clock);
  const tenant = scope?.tenantId ? 'AND tenant_id = {tenant:String}' : '';
  const target = scope?.target
    ? 'AND arrayExists((type, id) -> type = {targetType:String} AND id = {targetId:String}, target_types, target_ids)'
    : '';
  return {
    sql: `project_id = {project:String} AND (${filter.sql}) ${tenant} ${target}`,
    params: {
      ...filter.params,
      project: endpoint.projectId,
      ...(scope?.tenantId && { tenant: scope.tenantId }),
      ...(scope?.target && { targetType: scope.target.type, targetId: scope.target.id }),
    },
  };
}

export async function webhookEvent(
  ch: ClickHouseClient,
  endpoint: EndpointFilter,
  scope: WebhookScope | null,
  eventId: string,
  receivedAt: Date,
  filterClock: Date,
) {
  const match = scopePredicate(endpoint, scope, +filterClock);
  const [row] = await read<EventRow>(
    ch,
    `SELECT * FROM events WHERE ${match.sql} AND event_id = {id:String} AND received_at = {from:DateTime64(3,'UTC')}
      ORDER BY timestamp LIMIT 1 ${COMPLETE_READ}`,
    { ...match.params, id: eventId, from: receivedAt.toISOString() },
  );
  // The public projection keeps stored attribute text exact, including integers beyond JavaScript's safe range.
  return row ? toEvent(row) : null;
}

async function captureWatermark(projectId: string) {
  // Capture after current admissions commit their receipts. Their ClickHouse writes can still be in flight.
  return withIngestReceiptGate(projectId, 'exclusive', async (db) => {
    const [row] = await db.$queryRaw<{ now: Date; pending: Date | null }[]>`
        SELECT clock_timestamp() AS now, (
          SELECT min("receivedAt") FROM "IngestReceipt" WHERE "projectId"=${projectId} AND "confirmedAt" IS NULL
        ) AS pending`;
    return row ? webhookWatermark(row.now, row.pending) : null;
  });
}

// Keep the arrival-time predicate on the stored column so ClickHouse can use an arrival-time index when present.
function readWebhookCandidates(ch: ClickHouseClient, endpoint: WebhookEndpoint, scope: WebhookScope | null, sliceEnd: Date, now: Date) {
  const match = scopePredicate(endpoint, scope, +now);
  return read<{ event_id: string; received_ms: string | number }>(
    ch,
    `SELECT event_id, toUnixTimestamp64Milli(received_at) AS received_ms FROM events
        WHERE ${match.sql}
          AND timestamp >= subtractDays({from:DateTime64(3,'UTC')}, ${OCCURRED_AT_PAST_DAYS})
          AND timestamp < addDays({to:DateTime64(3,'UTC')}, ${OCCURRED_AT_FUTURE_DAYS})
          AND received_at >= {from:DateTime64(3,'UTC')} AND received_at < {to:DateTime64(3,'UTC')}
          ${endpoint.cursorEventId === null ? '' : "AND (received_at > {from:DateTime64(3,'UTC')} OR event_id > {cursorId:String})"}
        GROUP BY received_at, event_id ORDER BY received_at, event_id LIMIT ${DISCOVERY_PAGE_SIZE} ${COMPLETE_READ}`,
    {
      ...match.params,
      to: sliceEnd.toISOString(),
      from: endpoint.cursorReceivedAt.toISOString(),
      cursorId: endpoint.cursorEventId,
    },
  );
}

export async function discoverWebhookDeliveries(
  ch: ClickHouseClient,
  endpoint: WebhookEndpoint,
  clock?: Awaited<ReturnType<typeof webhookCursorClock>>,
) {
  if (!endpoint.enabled || endpoint.cursorReviewRequired) return;
  const cursorClock = clock ?? (await webhookCursorClock(prisma));
  const now = new Date();
  const snapshot = {
    id: endpoint.id,
    enabled: true,
    updatedAt: endpoint.updatedAt,
    cursorReceivedAt: endpoint.cursorReceivedAt,
    cursorEventId: endpoint.cursorEventId,
    cursorReviewRequired: false,
    lastScannedAt: endpoint.lastScannedAt,
    scopeTenantId: endpoint.scopeTenantId,
    scopeTargetType: endpoint.scopeTargetType,
    scopeTargetId: endpoint.scopeTargetId,
    scopeMask: { equals: endpoint.scopeMask },
    filterQuery: endpoint.filterQuery,
  };
  if (webhookCursorNeedsReview(endpoint, cursorClock)) {
    const blocked = await prisma.webhookEndpoint.updateMany({ where: snapshot, data: { cursorReviewRequired: true, updatedAt: endpoint.updatedAt } });
    if (blocked.count) console.warn(JSON.stringify({ event: 'webhook.cursor_review_required', endpointId: endpoint.id }));
    return;
  }
  let scanRecorded = false;
  try {
    const scope = storedWebhookScope(endpoint);
    if (scope === undefined) return;
    const watermark = await captureWatermark(endpoint.projectId);
    if (!watermark || watermark < endpoint.cursorReceivedAt) return;
    // A null ID denotes the first unexamined millisecond, including at endpoint creation. The end is exclusive.
    const sliceEnd = new Date(Math.min(+endpoint.cursorReceivedAt + DISCOVERY_SLICE_MS, +watermark + 1));
    const rows = await readWebhookCandidates(ch, endpoint, scope, sliceEnd, now);
    const deliveries = rows.map(({ event_id: eventId, received_ms }) => {
      const receivedAt = new Date(Number(received_ms));
      // NUL is forbidden in event IDs, so this namespace cannot overlap legacy lb1_ headers.
      const occurrence = `\0${JSON.stringify([endpoint.projectId, eventId, receivedAt])}`;
      return {
        endpointId: endpoint.id,
        eventId,
        receivedAt,
        webhookId: `lb1_${Buffer.from(occurrence, 'utf8').toString('base64url')}`,
        createdAt: now,
        expiresAt: new Date(+now + WEBHOOK_LOG_RETENTION_MS),
      };
    });
    const last = deliveries.at(-1);
    await prisma.$transaction(async (tx) => {
      const full = deliveries.length === DISCOVERY_PAGE_SIZE && last;
      const updated = await tx.webhookEndpoint.updateMany({
        where: snapshot,
        data: {
          cursorReceivedAt: full ? full.receivedAt : sliceEnd,
          cursorEventId: full ? full.eventId : null,
          lastScannedAt: new Date(Math.max(+now, +sliceEnd)),
          updatedAt: endpoint.updatedAt,
        },
      });
      if (updated.count && deliveries.length) await tx.webhookDelivery.createMany({ data: deliveries, skipDuplicates: true });
    });
    scanRecorded = true;
  } finally {
    // Move a busy/failing endpoint to the back of the scan without changing its cursor.
    if (!scanRecorded) await prisma.webhookEndpoint.updateMany({ where: snapshot, data: { lastScannedAt: now, updatedAt: endpoint.updatedAt } });
  }
}

export async function scanWebhooks(ch: ClickHouseClient) {
  const endpoints = await prisma.webhookEndpoint.findMany({
    where: { enabled: true, cursorReviewRequired: false },
    orderBy: [{ lastScannedAt: { sort: 'asc', nulls: 'first' } }, { id: 'asc' }],
    take: 32,
  });
  if (!endpoints.length) return;
  const clock = await webhookCursorClock(prisma);
  for (let index = 0; index < endpoints.length; index += 4) {
    await Promise.all(
      endpoints.slice(index, index + 4).map(async (endpoint) => {
        try {
          await discoverWebhookDeliveries(ch, endpoint, clock);
        } catch {
          console.error(JSON.stringify({ event: 'webhook.discovery_failed', endpointId: endpoint.id }));
        }
      }),
    );
  }
}
