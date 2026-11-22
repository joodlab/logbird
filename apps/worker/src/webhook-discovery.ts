import { type ClickHouseClient, compileQuery, type EventRow, read, toEvent } from '@logbird/clickhouse';
import { ProjectBusyError, prisma, type WebhookEndpoint, withProjectLock } from '@logbird/database';
import { WEBHOOK_LOG_RETENTION_MS } from '@logbird/database/webhooks';
import { webhookWatermark } from './webhook-policy';

const DISCOVERY_PAGE_SIZE = 100;
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
    `SELECT * FROM events WHERE ${match.sql} AND event_id = {id:String} AND received_at = {from:DateTime64(3)}
      ORDER BY timestamp LIMIT 1`,
    { ...match.params, id: eventId, from: receivedAt.toISOString() },
  );
  return row ? toEvent(row) : null;
}

async function captureWatermark(projectId: string) {
  // Acceptance's clock is assigned before the receipt write. Drain current admissions under the existing
  // project lock, then release it before scanning ClickHouse. Later admissions receive a newer clock.
  return withProjectLock(
    projectId,
    async (db) => {
      const [row] = await db.$queryRaw<{ now: Date; pending: Date | null }[]>`
        SELECT clock_timestamp() AS now, (
          SELECT min("receivedAt") FROM "IngestReceipt" WHERE "projectId"=${projectId} AND "confirmedAt" IS NULL
        ) AS pending`;
      return row ? webhookWatermark(row.now, row.pending) : null;
    },
    { waitMs: 200 },
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
    if (!watermark || watermark < endpoint.cursorReceivedAt || (+watermark === +endpoint.cursorReceivedAt && !endpoint.cursorEventId)) return;
    const match = scopePredicate(endpoint, +now);
    const rows = await read<{ event_id: string; delivery_received_at: string }>(
      ch,
      `SELECT event_id, min(received_at) AS delivery_received_at FROM events
        WHERE ${match.sql} AND received_at <= {to:DateTime64(3)}
          AND (received_at > {from:DateTime64(3)}
            ${endpoint.cursorEventId === null ? '' : 'OR (received_at = {from:DateTime64(3)} AND event_id > {cursorId:String})'})
        GROUP BY event_id ORDER BY delivery_received_at, event_id LIMIT ${DISCOVERY_PAGE_SIZE}`,
      {
        ...match.params,
        to: watermark.toISOString(),
        from: endpoint.cursorReceivedAt.toISOString(),
        cursorId: endpoint.cursorEventId,
      },
    );
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
          cursorReceivedAt: full ? full.receivedAt : watermark,
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
        } catch (error) {
          if (!(error instanceof ProjectBusyError)) console.error(JSON.stringify({ event: 'webhook.discovery_failed', endpointId: endpoint.id }));
        }
      }),
    );
  }
}
