import {
  type ClickHouseClient,
  compileQuery,
  type EventRow,
  OCCURRED_AT_FUTURE_DAYS,
  OCCURRED_AT_PAST_DAYS,
  read,
  toEvent,
} from '@logbird/clickhouse';
import { prisma, type WebhookEndpoint, withIngestReceiptGate } from '@logbird/database';
import { WEBHOOK_LOG_RETENTION_MS } from '@logbird/database/webhooks';
import { webhookWatermark } from './webhook-policy';

const DISCOVERY_PAGE_SIZE = 100;
const DISCOVERY_SLICE_MS = 5 * 60_000;
// A self-hosted ClickHouse profile may normally return partial reads on overflow. Never commit those to the cursor.
const COMPLETE_READ = `SETTINGS read_overflow_mode = 'throw', read_overflow_mode_leaf = 'throw', result_overflow_mode = 'throw',
  timeout_overflow_mode = 'throw', timeout_overflow_mode_leaf = 'throw', group_by_overflow_mode = 'throw', sort_overflow_mode = 'throw'`;
type EndpointScope = Pick<WebhookEndpoint, 'projectId' | 'filterQuery' | 'scopeTenantId' | 'scopeTargetType' | 'scopeTargetId'>;

function scopePredicate(endpoint: EndpointScope, clock?: number) {
  const filter = compileQuery(endpoint.filterQuery, clock);
  const tenant = endpoint.scopeTenantId === null ? '' : 'AND tenant_id = {tenant:String}';
  const target =
    endpoint.scopeTargetType === null
      ? ''
      : 'AND arrayExists((type, id) -> type = {targetType:String} AND id = {targetId:String}, target_types, target_ids)';
  return {
    sql: `project_id = {project:String} AND (${filter.sql}) ${tenant} ${target}`,
    params: {
      ...filter.params,
      project: endpoint.projectId,
      tenant: endpoint.scopeTenantId,
      targetType: endpoint.scopeTargetType,
      targetId: endpoint.scopeTargetId,
    },
  };
}

export async function webhookEvent(ch: ClickHouseClient, endpoint: EndpointScope, eventId: string, receivedAt: Date, filterClock: Date) {
  const match = scopePredicate(endpoint, +filterClock);
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
function readWebhookCandidates(ch: ClickHouseClient, endpoint: WebhookEndpoint, sliceEnd: Date, now: Date) {
  const match = scopePredicate(endpoint, +now);
  return read<{ event_id: string; delivery_received_at: string }>(
    ch,
    `SELECT event_id, min(received_at) AS delivery_received_at FROM events
        WHERE ${match.sql}
          AND timestamp >= subtractDays({from:DateTime64(3,'UTC')}, ${OCCURRED_AT_PAST_DAYS})
          AND timestamp < addDays({to:DateTime64(3,'UTC')}, ${OCCURRED_AT_FUTURE_DAYS})
          AND received_at >= {from:DateTime64(3,'UTC')} AND received_at < {to:DateTime64(3,'UTC')}
          ${endpoint.cursorEventId === null ? '' : "AND (received_at > {from:DateTime64(3,'UTC')} OR event_id > {cursorId:String})"}
        GROUP BY event_id ORDER BY delivery_received_at, event_id LIMIT ${DISCOVERY_PAGE_SIZE} ${COMPLETE_READ}`,
    {
      ...match.params,
      to: sliceEnd.toISOString(),
      from: endpoint.cursorReceivedAt.toISOString(),
      cursorId: endpoint.cursorEventId,
    },
  );
}

export async function discoverWebhookDeliveries(ch: ClickHouseClient, endpoint: WebhookEndpoint, now = new Date()) {
  const snapshot = {
    id: endpoint.id,
    enabled: true,
    updatedAt: endpoint.updatedAt,
    cursorReceivedAt: endpoint.cursorReceivedAt,
    cursorEventId: endpoint.cursorEventId,
    lastScannedAt: endpoint.lastScannedAt,
  };
  let scanRecorded = false;
  try {
    const watermark = await captureWatermark(endpoint.projectId);
    if (!watermark || watermark < endpoint.cursorReceivedAt) return;
    // A null ID denotes the first unexamined millisecond, including at endpoint creation. The end is exclusive.
    const sliceEnd = new Date(Math.min(+endpoint.cursorReceivedAt + DISCOVERY_SLICE_MS, +watermark + 1));
    const rows = await readWebhookCandidates(ch, endpoint, sliceEnd, now);
    const deliveries = rows.map((row) => ({
      endpointId: endpoint.id,
      eventId: row.event_id,
      receivedAt: new Date(row.delivery_received_at.endsWith('Z') ? row.delivery_received_at : `${row.delivery_received_at.replace(' ', 'T')}Z`),
      createdAt: now,
      expiresAt: new Date(+now + WEBHOOK_LOG_RETENTION_MS),
    }));
    const last = deliveries.at(-1);
    await prisma.$transaction(async (tx) => {
      const full = deliveries.length === DISCOVERY_PAGE_SIZE && last;
      const updated = await tx.webhookEndpoint.updateMany({
        where: snapshot,
        data: {
          cursorReceivedAt: full ? full.receivedAt : sliceEnd,
          cursorEventId: full ? full.eventId : null,
          lastScannedAt: now,
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
    where: { enabled: true },
    orderBy: [{ lastScannedAt: { sort: 'asc', nulls: 'first' } }, { id: 'asc' }],
    take: 32,
  });
  for (let index = 0; index < endpoints.length; index += 4) {
    await Promise.all(
      endpoints.slice(index, index + 4).map(async (endpoint) => {
        try {
          await discoverWebhookDeliveries(ch, endpoint);
        } catch {
          console.error(JSON.stringify({ event: 'webhook.discovery_failed', endpointId: endpoint.id }));
        }
      }),
    );
  }
}
