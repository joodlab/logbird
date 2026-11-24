import {
  type ClickHouseClient,
  compileMaskedQuery,
  type EventRow,
  OCCURRED_AT_FUTURE_DAYS,
  OCCURRED_AT_PAST_DAYS,
  QueryError,
  read,
  toEvent,
  WEBHOOK_FILTER,
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
type Predicate = ReturnType<typeof scopePredicate>;
// RE2 rejected a stored pattern. The same filter fails every scan, unlike timeouts, limits or network errors.
const PERMANENT_FILTER_ERRORS = new Set(['427', 'CANNOT_COMPILE_REGEXP']);

/** The clock only checks that relative times stay in range: `now` in a webhook filter is each event's arrival time. */
function scopePredicate(endpoint: EndpointFilter, scope: WebhookScope | null, clock: number) {
  const filter = compileMaskedQuery(endpoint.filterQuery, scope?.mask, clock, WEBHOOK_FILTER);
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
  abortSignal?: AbortSignal,
) {
  const match = scopePredicate(endpoint, scope, +receivedAt);
  const identity = `project_id = {project:String} AND event_id = {id:String} AND received_at = {from:DateTime64(3,'UTC')}`;
  const params = { ...match.params, id: eventId, from: receivedAt.toISOString() };
  const [row] = await read<EventRow>(
    ch,
    `SELECT * FROM events WHERE ${match.sql} AND event_id = {id:String} AND received_at = {from:DateTime64(3,'UTC')}
      ORDER BY timestamp LIMIT 1 ${COMPLETE_READ}`,
    params,
    undefined,
    undefined,
    undefined,
    abortSignal,
  );
  // The public projection keeps stored attribute text exact, including integers beyond JavaScript's safe range.
  if (row) return toEvent(row);
  if (!scope && !endpoint.filterQuery) return null;
  // Distinguish a present occurrence that is out of scope without loading its payload.
  const [present] = await read<{ present: number }>(
    ch,
    `SELECT 1 AS present FROM events WHERE ${identity} LIMIT 1 ${COMPLETE_READ}`,
    params,
    undefined,
    undefined,
    undefined,
    abortSignal,
  );
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
function readWebhookCandidates(ch: ClickHouseClient, endpoint: WebhookEndpoint, match: Predicate, sliceEnd: Date) {
  // The delivery window: only events that arrived no later than the window after they occurred (received_at - timestamp
  // <= window). Every candidate arrived at or after the cursor, so its occurrence time is at least cursor - window: that
  // bound on the sort key's timestamp column turns the scan into a primary-key range instead of ten years of parts.
  const window = endpoint.deliveryWindowSeconds;
  const occurredFrom =
    window === null
      ? `subtractDays({from:DateTime64(3,'UTC')}, ${OCCURRED_AT_PAST_DAYS})`
      : "subtractSeconds({from:DateTime64(3,'UTC')}, {window:UInt32})";
  return read<{ event_id: string; received_ms: string | number }>(
    ch,
    `SELECT event_id, toUnixTimestamp64Milli(received_at) AS received_ms FROM events
        WHERE ${match.sql}
          AND timestamp >= ${occurredFrom}
          ${window === null ? '' : 'AND timestamp >= subtractSeconds(received_at, {window:UInt32})'}
          AND timestamp < addDays({to:DateTime64(3,'UTC')}, ${OCCURRED_AT_FUTURE_DAYS})
          AND received_at >= {from:DateTime64(3,'UTC')} AND received_at < {to:DateTime64(3,'UTC')}
          ${endpoint.cursorEventId === null ? '' : "AND (received_at > {from:DateTime64(3,'UTC')} OR event_id > {cursorId:String})"}
        GROUP BY received_at, event_id ORDER BY received_at, event_id LIMIT ${DISCOVERY_PAGE_SIZE} ${COMPLETE_READ}`,
    {
      ...match.params,
      to: sliceEnd.toISOString(),
      from: endpoint.cursorReceivedAt.toISOString(),
      cursorId: endpoint.cursorEventId,
      ...(window === null ? {} : { window }),
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
  // Scheduling records every attempt independently of cursor progress and configuration edits.
  await prisma.webhookEndpoint.updateMany({
    where: { ...snapshot, OR: [{ scanAttemptedAt: null }, { scanAttemptedAt: { lt: cursorClock.now } }] },
    data: { scanAttemptedAt: cursorClock.now, updatedAt: endpoint.updatedAt },
  });
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
  const scope = storedWebhookScope(endpoint);
  if (scope === undefined) return;
  const holdInvalidFilter = async (error: unknown) => {
    // A stored filter that can never run would otherwise fail every scan silently while the endpoint looks enabled.
    const held = await prisma.webhookEndpoint.updateMany({
      where: snapshot,
      data: { filterReviewRequired: true, filterReviewReason: 'invalid_filter', filterReviewNoticeClaimedAt: null, updatedAt: endpoint.updatedAt },
    });
    if (held.count)
      console.warn(
        JSON.stringify({
          event: 'webhook.filter_invalid',
          endpointId: endpoint.id,
          reason: error instanceof QueryError ? error.details.reason : 'regex',
        }),
      );
  };
  let match: Predicate;
  try {
    match = scopePredicate(endpoint, scope, +cursorClock.now);
  } catch (error) {
    // Compilation is deterministic: a stored filter that fails it fails the same way on every scan.
    if (error instanceof QueryError) return holdInvalidFilter(error);
    throw error;
  }
  const bounds = await captureScanBounds(endpoint.projectId);
  if (!bounds) return;
  const lastScannedAt = new Date(Math.max(+bounds.now, +cursorClock.now, +(endpoint.lastScannedAt ?? cursorClock.now)));
  if (bounds.watermark < endpoint.cursorReceivedAt) return;
  // Wait until a short page can advance to the nominal start. A partially committed early page
  // can resume from its last delivery, whose row was committed with the cursor.
  if (early && +bounds.watermark + 1 < start) return;
  // A null ID denotes the first unexamined millisecond, including at endpoint creation. The end is exclusive.
  const sliceEnd = new Date(Math.min(+endpoint.cursorReceivedAt + DISCOVERY_SLICE_MS, +bounds.watermark + 1));
  let rows: Awaited<ReturnType<typeof readWebhookCandidates>>;
  try {
    rows = await readWebhookCandidates(ch, endpoint, match, sliceEnd);
  } catch (error) {
    if (endpoint.filterQuery && permanentFilterError(error)) return holdInvalidFilter(error);
    throw error;
  }
  const expiresAt = new Date(+bounds.now + WEBHOOK_LOG_RETENTION_MS);
  const commit = async (cursorReceivedAt: Date, cursorEventId: string | null, deliveries?: Prisma.WebhookDeliveryCreateManyInput[]) => {
    const position = { cursorReceivedAt, cursorEventId, lastScannedAt };
    const committed = await prisma.$transaction(async (tx) => {
      const updated = await tx.webhookEndpoint.updateMany({ where: snapshot, data: { ...position, updatedAt: endpoint.updatedAt } });
      if (!updated.count) return false;
      if (deliveries) await tx.webhookDelivery.createMany({ data: deliveries, skipDuplicates: true });
      return true;
    });
    if (committed) Object.assign(snapshot, position);
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
}

function permanentFilterError(error: unknown) {
  if (!error || typeof error !== 'object') return false;
  const { code, type } = error as { code?: unknown; type?: unknown };
  return PERMANENT_FILTER_ERRORS.has(String(code)) || PERMANENT_FILTER_ERRORS.has(String(type));
}

export async function scanWebhooks(ch: ClickHouseClient) {
  const endpoints = await prisma.webhookEndpoint.findMany({
    where: { enabled: true, cursorReviewRequired: false, filterReviewRequired: false },
    orderBy: [{ scanAttemptedAt: { sort: 'asc', nulls: 'first' } }, { id: 'asc' }],
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
