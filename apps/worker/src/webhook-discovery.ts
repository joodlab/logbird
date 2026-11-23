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
import { type Prisma, prisma, type WebhookEndpoint, withIngestReceiptGate } from '@logbird/database';
import { WEBHOOK_LOG_RETENTION_MS, webhookCursorClock, webhookCursorNeedsReview, webhookCursorStart } from '@logbird/database/webhooks';
import { webhookWatermark } from './webhook-policy';

const DISCOVERY_PAGE_SIZE = 10_000;
const DELIVERY_BATCH_SIZE = 100;
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
  const identity = `project_id = {project:String} AND event_id = {id:String} AND received_at = {from:DateTime64(3,'UTC')}`;
  const params = { ...match.params, id: eventId, from: receivedAt.toISOString() };
  const [row] = await read<EventRow>(
    ch,
    `SELECT * FROM events WHERE ${match.sql} AND event_id = {id:String} AND received_at = {from:DateTime64(3,'UTC')}
      ORDER BY timestamp LIMIT 1 ${COMPLETE_READ}`,
    params,
  );
  // The public projection keeps stored attribute text exact, including integers beyond JavaScript's safe range.
  if (row) return toEvent(row);
  if (!scope && !endpoint.filterQuery) return null;
  // Distinguish a present occurrence that is out of scope without loading its payload.
  const [present] = await read<{ present: number }>(ch, `SELECT 1 AS present FROM events WHERE ${identity} LIMIT 1 ${COMPLETE_READ}`, params);
  return present ? 'scope_mismatch' : null;
}

async function captureScanBounds(projectId: string) {
  // Capture after current admissions commit their receipts. Their ClickHouse writes can still be in flight.
  return withIngestReceiptGate(projectId, 'exclusive', async (db) => {
    const [row] = await db.$queryRaw<{ now: Date; pending: Date | null }[]>`
        SELECT clock_timestamp() AS now, (
          SELECT min("receivedAt") FROM "IngestReceipt" WHERE "projectId"=${projectId} AND "confirmedAt" IS NULL
        ) AS pending`;
    return row ? { now: row.now, watermark: webhookWatermark(row.now, row.pending) } : null;
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
  if (!endpoint.enabled || endpoint.cursorReviewRequired || endpoint.filterReviewRequired) return;
  const cursorClock = clock ?? (await webhookCursorClock(prisma));
  const start = webhookCursorStart(endpoint, cursorClock.rollout);
  const early = +endpoint.cursorReceivedAt < start;
  const snapshot = {
    id: endpoint.id,
    enabled: true,
    filterReviewRequired: false,
    updatedAt: endpoint.updatedAt,
    cursorReceivedAt: endpoint.cursorReceivedAt,
    cursorEventId: endpoint.cursorEventId,
    cursorReviewRequired: false,
    cursorVerifiedFloor: endpoint.cursorVerifiedFloor,
    lastScannedAt: endpoint.lastScannedAt,
    scopeTenantId: endpoint.scopeTenantId,
    scopeTargetType: endpoint.scopeTargetType,
    scopeTargetId: endpoint.scopeTargetId,
    scopeMask: { equals: endpoint.scopeMask },
    filterQuery: endpoint.filterQuery,
  };
  const earlyDelivery =
    early && endpoint.lastScannedAt && endpoint.cursorEventId
      ? await prisma.webhookDelivery.findUnique({
          where: {
            endpointId_eventId_receivedAt: {
              endpointId: endpoint.id,
              eventId: endpoint.cursorEventId,
              receivedAt: endpoint.cursorReceivedAt,
            },
          },
          select: { id: true },
        })
      : null;
  if (webhookCursorNeedsReview(endpoint, cursorClock, !!earlyDelivery)) {
    const blocked = await prisma.webhookEndpoint.updateMany({ where: snapshot, data: { cursorReviewRequired: true, updatedAt: endpoint.updatedAt } });
    if (blocked.count) console.warn(JSON.stringify({ event: 'webhook.cursor_review_required', endpointId: endpoint.id }));
    return;
  }
  let scanRecorded = false;
  // The compare-and-swap includes lastScannedAt, so a stale scan cannot overwrite a newer timestamp.
  let lastScannedAt = new Date(Math.max(+cursorClock.now, +(endpoint.lastScannedAt ?? cursorClock.now)));
  try {
    const scope = storedWebhookScope(endpoint);
    if (scope === undefined) return;
    const bounds = await captureScanBounds(endpoint.projectId);
    if (!bounds) return;
    if (bounds.now > lastScannedAt) lastScannedAt = bounds.now;
    if (bounds.watermark < endpoint.cursorReceivedAt) return;
    // Wait until a short page can advance to the nominal start. A partially committed early page
    // can resume from its last delivery, whose row was committed with the cursor.
    if (early && +bounds.watermark + 1 < start) return;
    // A null ID denotes the first unexamined millisecond, including at endpoint creation. The end is exclusive.
    const sliceEnd = new Date(Math.min(+endpoint.cursorReceivedAt + DISCOVERY_SLICE_MS, +bounds.watermark + 1));
    const rows = await readWebhookCandidates(ch, endpoint, scope, sliceEnd, bounds.now);
    const expiresAt = new Date(+bounds.now + WEBHOOK_LOG_RETENTION_MS);
    const commit = async (cursorReceivedAt: Date, cursorEventId: string | null, deliveries?: Prisma.WebhookDeliveryCreateManyInput[]) => {
      const position = { cursorReceivedAt, cursorEventId, lastScannedAt };
      const committed = await prisma.$transaction(async (tx) => {
        const updated = await tx.webhookEndpoint.updateMany({ where: snapshot, data: { ...position, updatedAt: endpoint.updatedAt } });
        if (!updated.count) return false;
        if (deliveries) await tx.webhookDelivery.createMany({ data: deliveries, skipDuplicates: true });
        return true;
      });
      if (committed) {
        Object.assign(snapshot, position);
        scanRecorded = true;
      }
      return committed;
    };
    for (let offset = 0; offset < rows.length; offset += DELIVERY_BATCH_SIZE) {
      const deliveries = rows.slice(offset, offset + DELIVERY_BATCH_SIZE).map(({ event_id: eventId, received_ms }) => {
        const receivedAt = new Date(Number(received_ms));
        // NUL is forbidden in event IDs, so this namespace cannot overlap legacy lb1_ headers.
        const occurrence = `\0${JSON.stringify([endpoint.projectId, eventId, receivedAt])}`;
        return {
          endpointId: endpoint.id,
          eventId,
          receivedAt,
          webhookId: `lb1_${Buffer.from(occurrence, 'utf8').toString('base64url')}`,
          // Re-evaluate relative-time filters at this same database instant on every send.
          createdAt: bounds.now,
          expiresAt,
        };
      });
      const last = deliveries.at(-1);
      // Keep each cursor advance atomic with its bounded set of deliveries. A stale endpoint stops this page.
      if (last && !(await commit(last.receivedAt, last.eventId, deliveries))) return;
    }
    // Only a fully consumed short page proves the remainder of the slice is empty.
    if (rows.length < DISCOVERY_PAGE_SIZE) await commit(sliceEnd, null);
  } finally {
    // Move a busy/failing endpoint to the back of the scan without changing its cursor.
    // An untouched early cursor must retain its never-scanned state until its first successful commit.
    if (!scanRecorded && (!early || endpoint.lastScannedAt))
      await prisma.webhookEndpoint.updateMany({ where: snapshot, data: { lastScannedAt, updatedAt: endpoint.updatedAt } });
  }
}

export async function scanWebhooks(ch: ClickHouseClient) {
  const endpoints = await prisma.webhookEndpoint.findMany({
    where: { enabled: true, cursorReviewRequired: false, filterReviewRequired: false },
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
