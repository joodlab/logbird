import { isDeepStrictEqual } from 'node:util';
import { type ClickHouseClient, maskEvent, normalizeEvent, toEvent } from '@logbird/clickhouse';
import { storedWebhookScope, type WebhookScope } from '@logbird/contracts';
import { hasAdminRole, Prisma, prisma, storeAuditEvent, type WebhookDelivery, type WebhookEndpoint, workspaceAdminRoles } from '@logbird/database';
import { activeWebhookSecrets, decryptWebhookSecret, WEBHOOK_LOG_RETENTION_MS } from '@logbird/database/webhooks';
import { MAX_WEBHOOK_SIGNATURES, signWebhook } from '@logbird/sdk';
import { webhookDatabaseTime } from './webhook-clock';
import { webhookEvent } from './webhook-discovery';
import { RETRY_WINDOW_MS, webhookRetryDelay } from './webhook-policy';
import { type AttemptResult, legacyWebhookHeaderId, postWebhook, TOTAL_TIMEOUT_MS, type WebhookTransportOptions } from './webhook-transport';

const LEASE_MS = 120_000;
const MAX_ENDPOINT_ATTEMPTS_PER_SECOND = 50;
type Claim = { delivery: WebhookDelivery; expired: boolean };
type ScopeColumns = Parameters<typeof storedWebhookScope>[0];
type DeliveryResult = Omit<AttemptResult, 'error'> & { error?: AttemptResult['error'] | 'scope_mismatch' };
type DeliveryOptions = {
  secretKey: Buffer;
  maskKey?: Buffer;
  concurrency: number;
  perEndpoint: number;
  failureLimit: number;
  transport?: WebhookTransportOptions;
  beforeRequest?: (tx: Prisma.TransactionClient) => Promise<void>;
};

const scopeWhere = ({ scopeTenantId, scopeTargetType, scopeTargetId, scopeMask }: ScopeColumns) => ({
  scopeTenantId,
  scopeTargetType,
  scopeTargetId,
  scopeMask: { equals: scopeMask },
});

export async function claimWebhookDeliveries(options: Pick<DeliveryOptions, 'concurrency' | 'perEndpoint'>, projectId?: string) {
  const held = new Map<string, { scope: ScopeColumns; updatedAt: Date }>();
  const claims = await prisma.$transaction(async (tx) => {
    const now = await webhookDatabaseTime(tx);
    // The delivery queue's global concurrency is one. Limit each endpoint independently and exclude live leases
    // from its allowance, even after a worker restarts while some requests are still in flight.
    const liveLeases = await tx.webhookDelivery.count({
      where: { status: 'pending', leaseUntil: { gt: now }, ...(projectId ? { endpoint: { projectId } } : {}) },
    });
    const capacity = options.concurrency - liveLeases;
    if (capacity <= 0) return [];
    const due = await tx.$queryRaw<(WebhookDelivery & { scope: ScopeColumns; scopeUpdatedAt: Date })[]>(Prisma.sql`
      SELECT d.*, e."updatedAt" AS "scopeUpdatedAt", jsonb_build_object(
        'scopeTenantId', e."scopeTenantId", 'scopeTargetType', e."scopeTargetType",
        'scopeTargetId', e."scopeTargetId", 'scopeMask', e."scopeMask"
      ) AS scope FROM "WebhookEndpoint" e
      CROSS JOIN LATERAL (
        SELECT id FROM "WebhookDelivery"
        WHERE "endpointId" = e.id AND status = 'pending'
          AND "nextAttemptAt" <= ${now} AND ("leaseUntil" IS NULL OR "leaseUntil" <= ${now})
        ORDER BY "nextAttemptAt", id
        LIMIT greatest(0, least(
          ${options.perEndpoint} - (
            SELECT count(*) FROM "WebhookDelivery"
            WHERE "endpointId" = e.id AND status = 'pending' AND "leaseUntil" > ${now}
          ),
          ${MAX_ENDPOINT_ATTEMPTS_PER_SECOND} - (
            SELECT count(*) FROM "WebhookAttempt" a JOIN "WebhookDelivery" recent ON recent.id = a."deliveryId"
            WHERE recent."endpointId" = e.id AND a."startedAt" > ${new Date(+now - 1000)}
          )
        ))
      ) candidate
      JOIN "WebhookDelivery" d ON d.id = candidate.id
      WHERE e.enabled AND NOT e."scopeReviewRequired"
        ${projectId ? Prisma.sql`AND e."projectId" = ${projectId}` : Prisma.empty}
      ORDER BY d."nextAttemptAt", d.id LIMIT ${capacity} FOR UPDATE OF d SKIP LOCKED`);
    const claims: Claim[] = [];
    for (const row of due) {
      if (storedWebhookScope(row.scope) === undefined) {
        held.set(row.endpointId, { scope: row.scope, updatedAt: row.scopeUpdatedAt });
        continue;
      }
      if (row.leaseUntil)
        await tx.webhookAttempt.updateMany({
          where: { deliveryId: row.id, number: row.attemptNumber, status: 'sending' },
          data: { status: 'interrupted' },
        });
      const expired = row.retryUntil !== null && row.retryUntil <= now;
      const delivery = await tx.webhookDelivery.update({
        where: { id: row.id },
        data: {
          leaseUntil: new Date(+now + LEASE_MS),
          ...(!expired && {
            attemptNumber: { increment: 1 },
            windowAttempts: { increment: 1 },
            retryUntil: row.retryUntil ?? new Date(+now + RETRY_WINDOW_MS),
          }),
        },
      });
      if (!expired)
        await tx.webhookAttempt.create({ data: { deliveryId: row.id, number: delivery.attemptNumber, startedAt: now, status: 'sending' } });
      claims.push({ delivery, expired });
    }
    return claims;
  });
  // Release delivery locks before marking endpoints. Endpoint edits lock the endpoint before its deliveries.
  await Promise.all(
    [...held].map(async ([id, { scope, updatedAt }]) => {
      try {
        await prisma.webhookEndpoint.updateMany({
          where: { id, updatedAt, ...scopeWhere(scope) },
          data: { scopeReviewRequired: true, updatedAt },
        });
      } catch {
        console.error(JSON.stringify({ event: 'webhook.scope_hold_failed', endpointId: id }));
      }
    }),
  );
  return claims;
}

function isSuccess(result?: DeliveryResult) {
  return result && !result.error && result.responseCode !== undefined && result.responseCode >= 200 && result.responseCode < 300;
}

async function settle(
  delivery: WebhookDelivery,
  snapshot: WebhookEndpoint | null | undefined,
  result: DeliveryResult | undefined,
  latencyMs: number,
  failureLimit: number,
) {
  const skipped = result?.error === 'scope_mismatch';
  const success = isSuccess(result);
  const gone = result?.responseCode === 410;
  const localFailure = result?.error === 'event_unavailable' || skipped;
  // Keep one lock order for endpoint mutations and settlement. The lease's sequence fences stale results.
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "WebhookEndpoint" WHERE id = ${delivery.endpointId} FOR UPDATE`;
    const now = await webhookDatabaseTime(tx);
    const retryUntil = delivery.retryUntil ?? now;
    const finished = !result || success || gone || localFailure || now >= retryUntil;
    const status = skipped ? 'skipped' : success ? 'succeeded' : finished ? 'failed' : 'pending';
    if (skipped && snapshot) {
      const current = await tx.webhookEndpoint.count({
        where: { id: snapshot.id, enabled: true, updatedAt: snapshot.updatedAt, filterQuery: snapshot.filterQuery, ...scopeWhere(snapshot) },
      });
      if (!current) return interruptClaim(tx, delivery);
    }
    const updated = await tx.webhookDelivery.updateMany({
      where: { id: delivery.id, status: 'pending', attemptNumber: delivery.attemptNumber, leaseUntil: delivery.leaseUntil },
      data: {
        status,
        leaseUntil: null,
        nextAttemptAt: finished ? null : new Date(Math.min(+retryUntil, +now + webhookRetryDelay(delivery.windowAttempts))),
        ...(finished && { expiresAt: new Date(+now + WEBHOOK_LOG_RETENTION_MS) }),
      },
    });
    if (!updated.count) return;
    if (result)
      await tx.webhookAttempt.update({
        where: { deliveryId_number: { deliveryId: delivery.id, number: delivery.attemptNumber } },
        data: { status: skipped ? 'skipped' : success ? 'succeeded' : 'failed', latencyMs, ...result },
      });
    if (localFailure || result?.error === 'signing_failed' || result?.error === 'lookup_failed') return;
    const endpoint = await tx.webhookEndpoint.findUniqueOrThrow({
      where: { id: delivery.endpointId },
      include: { project: { select: { id: true, organizationId: true, name: true } } },
    });
    if (!endpoint.enabled || (snapshot && +endpoint.updatedAt !== +snapshot.updatedAt)) return;
    // At the deadline, count an endpoint failure only when this retry window actually saw a receiver failure
    // under the current configuration. Expiring an internal lookup failure must not disable an endpoint.
    if (!result) {
      if (!endpoint.failingSince) return;
      const priorFailure = await tx.webhookAttempt.findFirst({
        where: {
          deliveryId: delivery.id,
          status: 'failed',
          startedAt: { gte: new Date(Math.max(+endpoint.updatedAt, +retryUntil - RETRY_WINDOW_MS)) },
          OR: [{ error: null }, { error: { in: ['destination_rejected', 'timeout', 'network_error'] } }],
        },
        select: { number: true },
      });
      if (!priorFailure) return;
    }

    const failures = success ? 0 : endpoint.consecutiveFailures + (finished ? 1 : 0);
    const startedAt = delivery.leaseUntil ? new Date(+delivery.leaseUntil - LEASE_MS) : now;
    const failingSince = success ? null : (endpoint.failingSince ?? startedAt);
    const reason = gone
      ? 'gone_410'
      : failures >= failureLimit || (failingSince && +now - +failingSince >= RETRY_WINDOW_MS)
        ? 'consecutive_failures'
        : null;
    await tx.webhookEndpoint.update({
      where: { id: endpoint.id },
      data: {
        consecutiveFailures: failures,
        failingSince,
        updatedAt: reason ? now : endpoint.updatedAt,
        ...(reason && { enabled: false, disabledAt: now, disabledReason: reason }),
      },
    });
    if (!reason) return;
    await storeAuditEvent(
      `ws:${endpoint.project.organizationId}`,
      {
        action: 'webhook.disabled',
        occurredAt: now.toISOString(),
        actor: { type: 'system', id: 'logbird-worker', name: 'Logbird worker' },
        targets: [
          { type: 'webhook', id: endpoint.id },
          { type: 'project', id: endpoint.project.id, name: endpoint.project.name },
        ],
        metadata: { webhook: { reason } },
      },
      tx,
    );
    const members = await tx.member.findMany({
      where: { organizationId: endpoint.project.organizationId, OR: workspaceAdminRoles.map((role) => ({ role: { contains: role } })) },
      select: { userId: true, role: true },
    });
    const recipients = new Set(members.filter(({ role }) => hasAdminRole(role)).map(({ userId }) => userId));
    await tx.webhookDisableNotice.createMany({
      data: [...recipients].map((userId) => ({ endpointId: endpoint.id, recipientId: userId, reason })),
    });
  });
}

function testEvent(delivery: WebhookDelivery, projectId: string) {
  const normalized = normalizeEvent(
    { id: delivery.eventId, action: 'logbird.webhook.test', description: 'Test webhook delivery from Logbird.' },
    { projectId, receivedAt: delivery.createdAt },
  );
  if (!normalized.ok) throw new Error('Invalid synthetic webhook event');
  return toEvent(normalized.row);
}

async function interruptClaim(
  tx: Prisma.TransactionClient,
  delivery: WebhookDelivery,
  reason: 'interrupted' | 'expired' | 'unstarted' = 'interrupted',
) {
  const updated = await tx.webhookDelivery.updateMany({
    where: { id: delivery.id, attemptNumber: delivery.attemptNumber, status: 'pending', leaseUntil: delivery.leaseUntil },
    data: {
      leaseUntil: null,
      ...(reason !== 'expired' && { windowAttempts: { decrement: 1 }, ...(delivery.windowAttempts === 1 ? { retryUntil: null } : {}) }),
      ...(reason === 'unstarted' && { attemptNumber: { decrement: 1 } }),
    },
  });
  if (!updated.count || reason === 'expired') return;
  const where = { deliveryId: delivery.id, number: delivery.attemptNumber, status: 'sending' };
  if (reason === 'unstarted') await tx.webhookAttempt.deleteMany({ where });
  else await tx.webhookAttempt.updateMany({ where, data: { status: 'interrupted' } });
}

function sameDispatchSettings(current: WebhookEndpoint, snapshot: WebhookEndpoint) {
  return (
    current.enabled &&
    !current.scopeReviewRequired &&
    +current.updatedAt === +snapshot.updatedAt &&
    current.url === snapshot.url &&
    current.filterQuery === snapshot.filterQuery &&
    current.scopeTenantId === snapshot.scopeTenantId &&
    current.scopeTargetType === snapshot.scopeTargetType &&
    current.scopeTargetId === snapshot.scopeTargetId &&
    isDeepStrictEqual(current.scopeMask, snapshot.scopeMask)
  );
}

async function attemptDelivery(
  ch: ClickHouseClient,
  delivery: WebhookDelivery,
  endpoint: WebhookEndpoint,
  scope: WebhookScope | null,
  options: DeliveryOptions,
): Promise<DeliveryResult | undefined> {
  if (scope?.mask?.includes('actor_email') && !options.maskKey) return { error: 'signing_failed' } as const;
  const event = delivery.receivedAt
    ? await webhookEvent(ch, endpoint, scope, delivery.eventId, delivery.receivedAt, delivery.createdAt)
    : testEvent(delivery, endpoint.projectId);
  if (!event) return { error: 'event_unavailable' } as const;
  if (event === 'scope_mismatch') return { error: event };
  const webhookId = delivery.webhookId ?? legacyWebhookHeaderId(delivery.eventId);
  const body = JSON.stringify(maskEvent(event, scope?.mask, options.maskKey));
  let overlapAt: Date | undefined;
  const result = await postWebhook(
    endpoint.url,
    webhookId,
    body,
    (startRequest) =>
      prisma.$transaction(async (tx) => {
        // Endpoint writers take their lock before touching deliveries. Hold both rows until the request starts.
        const [current] = await tx.$queryRaw<WebhookEndpoint[]>`SELECT * FROM "WebhookEndpoint" WHERE id = ${endpoint.id} FOR SHARE`;
        if (!current || !sameDispatchSettings(current, endpoint)) return;
        const [live] = await tx.$queryRaw<Pick<WebhookDelivery, 'attemptNumber' | 'leaseUntil' | 'retryUntil'>[]>`
          SELECT "attemptNumber", "leaseUntil", "retryUntil" FROM "WebhookDelivery"
          WHERE id = ${delivery.id} AND status = 'pending' FOR SHARE`;
        if (
          !live?.leaseUntil ||
          !live.retryUntil ||
          live.attemptNumber !== delivery.attemptNumber ||
          +live.leaseUntil !== delivery.leaseUntil?.getTime() ||
          +live.retryUntil !== delivery.retryUntil?.getTime()
        )
          return;
        await options.beforeRequest?.(tx);
        const clockStarted = performance.now();
        const signingTime = await webhookDatabaseTime(tx);
        const timeRemaining = Math.min(+live.leaseUntil, +live.retryUntil) - +signingTime;
        if (timeRemaining <= 0) return;
        const secrets = await tx.webhookSecret.findMany({
          where: { endpointId: endpoint.id, ...activeWebhookSecrets(signingTime) },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: MAX_WEBHOOK_SIGNATURES + 1,
          select: { ciphertext: true },
        });
        if (secrets.length > MAX_WEBHOOK_SIGNATURES && !current.secretOverlapWarnedAt) overlapAt = signingTime;
        const timestamp = Math.floor(+signingTime / 1000);
        let signature: string;
        try {
          const keys = secrets.slice(0, MAX_WEBHOOK_SIGNATURES).map(({ ciphertext }) => decryptWebhookSecret(ciphertext, options.secretKey));
          signature = await signWebhook({ id: webhookId, timestamp, payload: body, secrets: keys });
        } catch {
          return { error: 'signing_failed' } as const;
        }
        // Account for time spent preparing the signature without relying on the worker's wall clock.
        if (performance.now() - clockStarted >= timeRemaining) return;
        // The response promise is boxed so Prisma commits without waiting for the receiver.
        return startRequest(timestamp, signature);
      }, dispatchTransactionOptions(options.transport)),
    options.transport,
  );
  if (overlapAt) {
    try {
      const warned = await prisma.webhookEndpoint.updateMany({
        where: { id: endpoint.id, updatedAt: endpoint.updatedAt, secretOverlapWarnedAt: null },
        data: { secretOverlapWarnedAt: overlapAt, updatedAt: endpoint.updatedAt },
      });
      if (warned.count)
        console.warn(
          JSON.stringify({ level: 'warn', event: 'webhook.secret_overlap_limit', endpointId: endpoint.id, maxSignatures: MAX_WEBHOOK_SIGNATURES }),
        );
    } catch {
      console.error(JSON.stringify({ event: 'webhook.secret_overlap_warning_failed', endpointId: endpoint.id }));
    }
  }
  return result;
}

/**
 * The dispatch transaction only locks and reads; it ends once the request has started. The attempt's own deadlines
 * (connect budget, total timeout) decide a slow final check, so the transaction outlives the total timeout by a margin
 * instead of Prisma's default 5 seconds, then closes even if PostgreSQL never answers.
 */
const DISPATCH_TRANSACTION_MARGIN_MS = 2000;
const dispatchTransactionOptions = (transport?: WebhookTransportOptions) => ({
  timeout: (transport?.totalTimeoutMs ?? TOTAL_TIMEOUT_MS) + DISPATCH_TRANSACTION_MARGIN_MS,
});

async function sendClaim(ch: ClickHouseClient, { delivery, expired }: Claim, options: DeliveryOptions) {
  const start = performance.now();
  let endpoint: WebhookEndpoint | null | undefined;
  let result: DeliveryResult | undefined;
  try {
    endpoint = await prisma.webhookEndpoint.findUnique({ where: { id: delivery.endpointId } });
    if (endpoint?.enabled) {
      const scope = storedWebhookScope(endpoint);
      if (scope !== undefined) {
        if (expired) return settle(delivery, endpoint, undefined, 0, options.failureLimit);
        result = await attemptDelivery(ch, delivery, endpoint, scope, options);
      }
    }
  } catch (error) {
    if (expired) throw error;
    result = { error: 'lookup_failed' };
  }
  if (!result) {
    // No request started. Remove the tentative attempt so the next claim can rebuild it.
    const reason = expired ? 'expired' : 'unstarted';
    return prisma.$transaction((tx) => interruptClaim(tx, delivery, reason));
  }
  await settle(delivery, endpoint, result, Math.round(performance.now() - start), options.failureLimit);
}

export async function deliverWebhooks(ch: ClickHouseClient, options: DeliveryOptions, projectId?: string) {
  const claims = await claimWebhookDeliveries(options, projectId);
  const results = await Promise.allSettled(claims.map((claim) => sendClaim(ch, claim, options)));
  for (const [index, result] of results.entries()) {
    if (result.status === 'rejected') console.error(JSON.stringify({ event: 'webhook.delivery_failed', deliveryId: claims[index]?.delivery.id }));
  }
}
