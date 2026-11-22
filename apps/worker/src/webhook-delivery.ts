import { type ClickHouseClient, normalizeEvent, toEvent } from '@logbird/clickhouse';
import { hasAdminRole, Prisma, prisma, storeAuditEvent, type WebhookDelivery, type WebhookEndpoint, workspaceAdminRoles } from '@logbird/database';
import { activeWebhookSecrets, decryptWebhookSecret, WEBHOOK_LOG_RETENTION_MS } from '@logbird/database/webhooks';
import { MAX_WEBHOOK_SIGNATURES } from '@logbird/sdk';
import { webhookEvent } from './webhook-discovery';
import { RETRY_WINDOW_MS, webhookRetryDelay } from './webhook-policy';
import { type AttemptResult, postWebhook, type WebhookTransportOptions } from './webhook-transport';

const LEASE_MS = 120_000;
const MAX_ENDPOINT_ATTEMPTS_PER_SECOND = 50;
type Claim = { delivery: WebhookDelivery; expired: boolean };
type DeliveryOptions = {
  secretKey: Buffer;
  concurrency: number;
  perEndpoint: number;
  failureLimit: number;
  transport?: WebhookTransportOptions;
};

export async function claimWebhookDeliveries(options: Pick<DeliveryOptions, 'concurrency' | 'perEndpoint'>, projectId?: string, now = new Date()) {
  return prisma.$transaction(async (tx) => {
    // The delivery queue's global concurrency is one. Limit each endpoint independently and exclude live leases
    // from its allowance, even after a worker restarts while some requests are still in flight.
    const liveLeases = await tx.webhookDelivery.count({
      where: { status: 'pending', leaseUntil: { gt: now }, ...(projectId ? { endpoint: { projectId } } : {}) },
    });
    const capacity = options.concurrency - liveLeases;
    if (capacity <= 0) return [];
    const due = await tx.$queryRaw<WebhookDelivery[]>(Prisma.sql`
      SELECT d.* FROM "WebhookEndpoint" e
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
      WHERE e.enabled ${projectId ? Prisma.sql`AND e."projectId" = ${projectId}` : Prisma.empty}
      ORDER BY d."nextAttemptAt", d.id LIMIT ${capacity} FOR UPDATE OF d SKIP LOCKED`);
    const claims: Claim[] = [];
    for (const row of due) {
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
}

function isSuccess(result?: AttemptResult) {
  return result && !result.error && result.responseCode !== undefined && result.responseCode >= 200 && result.responseCode < 300;
}

async function settle(
  delivery: WebhookDelivery,
  configAt: Date | undefined,
  result: AttemptResult | undefined,
  latencyMs: number,
  failureLimit: number,
  now = new Date(),
) {
  const success = isSuccess(result);
  const gone = result?.responseCode === 410;
  const localFailure = result?.error === 'event_unavailable';
  const retryUntil = delivery.retryUntil ?? now;
  const finished = !result || success || gone || localFailure || now >= retryUntil;
  const status = success ? 'succeeded' : finished ? 'failed' : 'pending';
  // Keep one lock order for endpoint mutations and settlement. The lease's sequence fences stale results.
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "WebhookEndpoint" WHERE id = ${delivery.endpointId} FOR UPDATE`;
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
        data: { status: success ? 'succeeded' : 'failed', latencyMs, ...result },
      });
    if (localFailure || result?.error === 'signing_failed' || result?.error === 'lookup_failed') return;
    const endpoint = await tx.webhookEndpoint.findUniqueOrThrow({
      where: { id: delivery.endpointId },
      include: { project: { select: { id: true, organizationId: true, name: true } } },
    });
    if (!endpoint.enabled || (configAt && +endpoint.updatedAt !== +configAt)) return;
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
        ...(reason ? { enabled: false, disabledAt: now, disabledReason: reason } : { updatedAt: endpoint.updatedAt }),
      },
    });
    if (!reason) return;
    await storeAuditEvent(
      `ws:${endpoint.project.organizationId}`,
      {
        action: 'webhook.disabled',
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

async function interruptClaim(delivery: WebhookDelivery) {
  await prisma.$transaction(async (tx) => {
    const updated = await tx.webhookDelivery.updateMany({
      where: { id: delivery.id, attemptNumber: delivery.attemptNumber, status: 'pending', leaseUntil: delivery.leaseUntil },
      data: { leaseUntil: null, windowAttempts: { decrement: 1 }, ...(delivery.windowAttempts === 1 ? { retryUntil: null } : {}) },
    });
    if (updated.count)
      await tx.webhookAttempt.updateMany({
        where: { deliveryId: delivery.id, number: delivery.attemptNumber, status: 'sending' },
        data: { status: 'interrupted' },
      });
  });
}

async function attemptDelivery(ch: ClickHouseClient, delivery: WebhookDelivery, endpoint: WebhookEndpoint, options: DeliveryOptions) {
  const event = delivery.receivedAt
    ? await webhookEvent(ch, endpoint, delivery.eventId, delivery.receivedAt, delivery.createdAt)
    : testEvent(delivery, endpoint.projectId);
  if (!event) return { error: 'event_unavailable' } as const;
  const now = new Date();
  const secrets = await prisma.webhookSecret.findMany({
    where: { endpointId: endpoint.id, ...activeWebhookSecrets(now) },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: MAX_WEBHOOK_SIGNATURES + 1,
    select: { ciphertext: true },
  });
  if (secrets.length > MAX_WEBHOOK_SIGNATURES && !endpoint.secretOverlapWarnedAt) {
    const warned = await prisma.webhookEndpoint.updateMany({
      where: { id: endpoint.id, updatedAt: endpoint.updatedAt, secretOverlapWarnedAt: null },
      data: { secretOverlapWarnedAt: now, updatedAt: endpoint.updatedAt },
    });
    if (warned.count)
      console.warn(
        JSON.stringify({ level: 'warn', event: 'webhook.secret_overlap_limit', endpointId: endpoint.id, maxSignatures: MAX_WEBHOOK_SIGNATURES }),
      );
  }
  let keys: string[];
  try {
    keys = secrets.slice(0, MAX_WEBHOOK_SIGNATURES).map(({ ciphertext }) => decryptWebhookSecret(ciphertext, options.secretKey));
  } catch {
    return { error: 'signing_failed' } as const;
  }
  // Check the snapshot after DNS so an edit during resolution cannot send to a superseded URL or scope.
  return postWebhook(endpoint.url, delivery.eventId, JSON.stringify(event), keys, options.transport, async () => {
    const now = new Date();
    const unchanged = await prisma.webhookEndpoint.count({
      where: {
        id: endpoint.id,
        updatedAt: endpoint.updatedAt,
        enabled: true,
        deliveries: {
          some: { id: delivery.id, attemptNumber: delivery.attemptNumber, leaseUntil: { gt: now }, retryUntil: { gt: now }, status: 'pending' },
        },
      },
    });
    return unchanged > 0 && !!delivery.retryUntil && delivery.retryUntil > new Date();
  });
}

async function sendClaim(ch: ClickHouseClient, { delivery, expired }: Claim, options: DeliveryOptions) {
  if (expired) return settle(delivery, undefined, undefined, 0, options.failureLimit);
  const start = Date.now();
  let endpoint: WebhookEndpoint | null | undefined;
  let result: AttemptResult | undefined;
  try {
    endpoint = await prisma.webhookEndpoint.findUnique({ where: { id: delivery.endpointId } });
    if (endpoint?.enabled) result = await attemptDelivery(ch, delivery, endpoint, options);
  } catch {
    result = { error: 'lookup_failed' };
  }
  if (!result) return interruptClaim(delivery);
  await settle(delivery, endpoint?.updatedAt, result, Date.now() - start, options.failureLimit);
}

export async function deliverWebhooks(ch: ClickHouseClient, options: DeliveryOptions, projectId?: string, now = new Date()) {
  const claims = await claimWebhookDeliveries(options, projectId, now);
  const results = await Promise.allSettled(claims.map((claim) => sendClaim(ch, claim, options)));
  for (const [index, result] of results.entries()) {
    if (result.status === 'rejected') console.error(JSON.stringify({ event: 'webhook.delivery_failed', deliveryId: claims[index]?.delivery.id }));
  }
}
