import { setTimeout as delay } from 'node:timers/promises';
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
const DISPATCH_MAX_MS = 9000;
const DISPATCH_DEADLINE_MARGIN_MS = 250;
const DISPATCH_TX_TIMEOUT_MS = DISPATCH_MAX_MS + 1000;
// A dispatch can hold the only pool connection through its deadline and transaction cleanup.
const SETTLE_MAX_WAIT_MS = Math.max(TOTAL_TIMEOUT_MS, DISPATCH_TX_TIMEOUT_MS) + DISPATCH_DEADLINE_MARGIN_MS + 2000;
const SETTLE_TX_TIMEOUT_MS = 15_000;
const SETTLE_MAX_BACKOFF_MS = 1000;
const SETTLE_LEASE_MARGIN_MS = 1000;
// Leave room for two full settlement transactions, including acquisition, and a retry backoff.
const SETTLE_RESERVE_MS = 2 * (SETTLE_MAX_WAIT_MS + SETTLE_TX_TIMEOUT_MS) + SETTLE_MAX_BACKOFF_MS + SETTLE_LEASE_MARGIN_MS;
const MAX_ENDPOINT_ATTEMPTS_PER_SECOND = 50;
// Selection rounds per pass: each round skips the rows and projects that the previous rounds could not claim.
const CLAIM_ROUNDS = 4;
type Claim = { delivery: WebhookDelivery; expired: boolean; leaseDeadline: number };
type ScopeColumns = Parameters<typeof storedWebhookScope>[0];
type DeliveryResult = Omit<AttemptResult, 'error'> & { error?: AttemptResult['error'] | 'scope_mismatch' };
type DeliveryOptions = {
  secretKey: Buffer;
  maskKey?: Buffer;
  concurrency: number;
  perEndpoint: number;
  failureLimit: number;
  transport?: WebhookTransportOptions;
  beforeRequest?: (tx: Prisma.TransactionClient, delivery: WebhookDelivery) => Promise<void>;
};

const scopeWhere = ({ scopeTenantId, scopeTargetType, scopeTargetId, scopeMask }: ScopeColumns) => ({
  scopeTenantId,
  scopeTargetType,
  scopeTargetId,
  scopeMask: { equals: scopeMask },
});

type DueRow = { id: string; endpointId: string; projectId: string; scope: ScopeColumns; scopeUpdatedAt: Date };

/** Lock, recheck and claim one project's chosen rows with set-based writes in a short transaction of their own. */
async function claimRows(ids: string[], now: Date, leaseDeadline: number): Promise<Claim[]> {
  // Bind UTC wall time to the timestamp columns independently of the session time zone.
  const at = (time: Date) => Prisma.sql`${time.toISOString()}::timestamp`;
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL lock_timeout = '1s'`;
    await tx.$executeRaw`SET LOCAL statement_timeout = '2s'`;
    // A settlement, resend or endpoint edit can change a row between selection and this lock.
    const locked = await tx.$queryRaw<{ id: string; leased: boolean }[]>`
      SELECT id, "leaseUntil" IS NOT NULL AS leased FROM "WebhookDelivery"
      WHERE id = ANY(${ids}::text[]) AND status = 'pending' AND "nextAttemptAt" <= ${at(now)}
        AND ("leaseUntil" IS NULL OR "leaseUntil" <= ${at(now)})
      ORDER BY "nextAttemptAt", id FOR UPDATE SKIP LOCKED`;
    if (!locked.length) return [];
    const leased = locked.filter((row) => row.leased).map((row) => row.id);
    if (leased.length)
      await tx.$executeRaw`
        UPDATE "WebhookAttempt" a SET status = 'interrupted' FROM "WebhookDelivery" d
        WHERE d.id = ANY(${leased}::text[]) AND a."deliveryId" = d.id AND a.number = d."attemptNumber" AND a.status = 'sending'`;
    // An expired row only takes the lease, so the claimant can settle its ended retry window without a new attempt.
    const claimed = await tx.$queryRaw<(WebhookDelivery & { expired: boolean })[]>`
      UPDATE "WebhookDelivery" d SET
        "leaseUntil" = ${at(new Date(+now + LEASE_MS))},
        "attemptNumber" = d."attemptNumber" + CASE WHEN d."retryUntil" <= ${at(now)} THEN 0 ELSE 1 END,
        "windowAttempts" = d."windowAttempts" + CASE WHEN d."retryUntil" <= ${at(now)} THEN 0 ELSE 1 END,
        "retryUntil" = coalesce(d."retryUntil", ${at(new Date(+now + RETRY_WINDOW_MS))})
      WHERE d.id = ANY(${locked.map((row) => row.id)}::text[])
      RETURNING d.*, coalesce(d."retryUntil" <= ${at(now)}, false) AS expired`;
    const attempts = claimed.filter((row) => !row.expired);
    if (attempts.length)
      await tx.webhookAttempt.createMany({
        data: attempts.map((row) => ({ deliveryId: row.id, number: row.attemptNumber, startedAt: now, status: 'sending' })),
      });
    const byId = new Map(claimed.map(({ expired, ...delivery }) => [delivery.id, { delivery, expired, leaseDeadline }]));
    return locked.flatMap(({ id }) => byId.get(id) ?? []);
  });
}

export async function claimWebhookDeliveries(options: Pick<DeliveryOptions, 'concurrency' | 'perEndpoint'>, projectId?: string | readonly string[]) {
  const projects = projectId === undefined ? undefined : typeof projectId === 'string' ? [projectId] : [...projectId];
  const held = new Map<string, { scope: ScopeColumns; updatedAt: Date }>();
  // Sample before PostgreSQL's clock so the local retry deadline is conservative and immune to host clock skew.
  const leaseDeadline = performance.now() + LEASE_MS;
  const now = await webhookDatabaseTime();
  // The delivery queue's global concurrency is one. Limit each endpoint independently and exclude live leases
  // from its allowance, even after a worker restarts while some requests are still in flight.
  const liveLeases = await prisma.webhookDelivery.count({
    where: { status: 'pending', leaseUntil: { gt: now }, ...(projects ? { endpoint: { projectId: { in: projects } } } : {}) },
  });
  const capacity = options.concurrency - liveLeases;
  if (capacity <= 0) return [];
  // Choose without locks, then claim each project's rows in its own transaction: a slow or failing claim for one
  // project cannot roll back another project's claims. Candidates alternate between projects (each project's oldest
  // due row first, then each project's second, and so on), so one project's backlog cannot fill every slot.
  const choose = (limit: number, skippedIds: string[], failedProjects: string[]) =>
    prisma.$queryRaw<DueRow[]>(Prisma.sql`
    SELECT id, "endpointId", "projectId", "scopeUpdatedAt", scope FROM (
      SELECT d.id, d."endpointId", e."projectId", e."updatedAt" AS "scopeUpdatedAt", d."nextAttemptAt", jsonb_build_object(
        'scopeTenantId', e."scopeTenantId", 'scopeTargetType', e."scopeTargetType",
        'scopeTargetId', e."scopeTargetId", 'scopeMask', e."scopeMask"
      ) AS scope,
      row_number() OVER (PARTITION BY e."projectId" ORDER BY d."nextAttemptAt", d.id) AS turn
      FROM "WebhookEndpoint" e
      CROSS JOIN LATERAL (
        SELECT id FROM "WebhookDelivery"
        WHERE "endpointId" = e.id AND status = 'pending'
          AND "nextAttemptAt" <= ${now} AND ("leaseUntil" IS NULL OR "leaseUntil" <= ${now})
          AND NOT (id = ANY(${skippedIds}::text[]))
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
      WHERE e.enabled AND NOT e."scopeReviewRequired" AND NOT e."filterReviewRequired"
        AND NOT (e."projectId" = ANY(${failedProjects}::text[]))
        ${projects ? Prisma.sql`AND e."projectId" = ANY(${projects}::text[])` : Prisma.empty}
    ) chosen
    ORDER BY turn, "nextAttemptAt", id LIMIT ${limit}`);
  const claims: Claim[] = [];
  const skippedIds: string[] = [];
  const skippedProjects: string[] = [];
  // A chosen row can be locked elsewhere or change before its claim, and a project's claim can fail. Refill the
  // unused capacity past those rows within this pass, a bounded number of times. A project that yields no claimable
  // row or fails is left out of the remaining rounds, so its other locked rows cannot take every round.
  for (let round = 0; round < CLAIM_ROUNDS && claims.length < capacity; round++) {
    let due: DueRow[];
    try {
      due = await choose(capacity - claims.length, skippedIds, skippedProjects);
    } catch (error) {
      // Claims committed in earlier rounds hold leases: return them for dispatch instead of stranding them.
      if (!round) throw error;
      console.error(JSON.stringify({ level: 'error', event: 'webhook.claim_refill_failed', round, claimed: claims.length }));
      break;
    }
    if (!due.length) break;
    const byProject = new Map<string, string[]>();
    for (const row of due) {
      skippedIds.push(row.id);
      if (storedWebhookScope(row.scope) === undefined) held.set(row.endpointId, { scope: row.scope, updatedAt: row.scopeUpdatedAt });
      else byProject.set(row.projectId, [...(byProject.get(row.projectId) ?? []), row.id]);
    }
    for (const [project, ids] of byProject) {
      try {
        const claimed = await claimRows(ids, now, leaseDeadline);
        if (!claimed.length) skippedProjects.push(project);
        claims.push(...claimed);
      } catch {
        skippedProjects.push(project);
        console.error(JSON.stringify({ level: 'error', event: 'webhook.claim_failed', projectId: project, deliveries: ids.length }));
      }
    }
  }
  // Mark endpoints after the claim transactions commit. Endpoint edits lock the endpoint before its deliveries.
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
  maxWait = 2000,
) {
  const skipped = result?.error === 'scope_mismatch';
  const success = isSuccess(result);
  const gone = result?.responseCode === 410;
  const localFailure = result?.error === 'event_unavailable' || skipped;
  const transactionOptions = { maxWait, timeout: SETTLE_TX_TIMEOUT_MS };
  // Keep one lock order for endpoint mutations and settlement. The lease's sequence fences stale results.
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL lock_timeout = '11s'`;
    await tx.$executeRaw`SET LOCAL statement_timeout = '12s'`;
    await tx.$queryRaw`SELECT id FROM "WebhookEndpoint" WHERE id = ${delivery.endpointId} FOR UPDATE`;
    // Once the endpoint is locked, leave time to commit even if a subsequent statement stalls.
    await tx.$executeRaw`SET LOCAL lock_timeout = '1s'`;
    await tx.$executeRaw`SET LOCAL statement_timeout = '2s'`;
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
  }, transactionOptions);
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
    !current.filterReviewRequired &&
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
  { delivery, leaseDeadline }: Claim,
  endpoint: WebhookEndpoint,
  scope: WebhookScope | null,
  options: DeliveryOptions,
  warnOverlap: (time: Date) => void,
): Promise<DeliveryResult | undefined> {
  if (scope?.mask?.includes('actor_email') && !options.maskKey) return { error: 'signing_failed' } as const;
  const transportTimeout = options.transport?.totalTimeoutMs ?? TOTAL_TIMEOUT_MS;
  let event: Awaited<ReturnType<typeof webhookEvent>> | ReturnType<typeof testEvent>;
  if (delivery.receivedAt) {
    // The event read runs before the HTTP timer. Stop it while the lease still fits the dispatch, the request and
    // settlement. A slow read then becomes a retryable lookup failure with a later attempt time, so it cannot hold
    // the only delivery slot while other endpoints wait.
    const budget = Math.floor(leaseDeadline - SETTLE_RESERVE_MS - 2 * transportTimeout - performance.now());
    if (budget <= 0) return { error: 'lookup_failed' } as const;
    try {
      event = await webhookEvent(ch, endpoint, scope, delivery.eventId, delivery.receivedAt, AbortSignal.timeout(budget));
    } catch {
      return { error: 'lookup_failed' } as const;
    }
  } else event = testEvent(delivery, endpoint.projectId);
  if (!event) return { error: 'event_unavailable' } as const;
  if (event === 'scope_mismatch') return { error: event };
  const webhookId = delivery.webhookId ?? legacyWebhookHeaderId(delivery.eventId);
  const body = JSON.stringify(maskEvent(event, scope?.mask, options.maskKey));
  return postWebhook(
    endpoint.url,
    webhookId,
    body,
    (startRequest, deadline) =>
      prisma.$transaction(
        async (tx) => {
          const dispatchDeadline = Math.min(deadline - DISPATCH_DEADLINE_MARGIN_MS, performance.now() + DISPATCH_MAX_MS);
          await boundDispatchWaits(tx, dispatchDeadline);
          // Endpoint writers take their lock before touching deliveries. Hold both rows until the request starts.
          const [current] = await tx.$queryRaw<WebhookEndpoint[]>`SELECT * FROM "WebhookEndpoint" WHERE id = ${endpoint.id} FOR SHARE`;
          if (!current || !sameDispatchSettings(current, endpoint)) return;
          await boundDispatchWaits(tx, dispatchDeadline);
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
          if (options.beforeRequest) {
            await boundDispatchWaits(tx, dispatchDeadline);
            await options.beforeRequest(tx, delivery);
          }
          await boundDispatchWaits(tx, dispatchDeadline);
          const clockStarted = performance.now();
          const signingTime = await webhookDatabaseTime(tx);
          const leaseRemaining = +live.leaseUntil - SETTLE_RESERVE_MS - transportTimeout - +signingTime;
          const retryRemaining = +live.retryUntil - +signingTime;
          // The next claim settles an ended retry window. Without enough lease left, record a retryable lookup failure
          // so the row moves back in the queue instead of winning the next claim again.
          if (retryRemaining <= 0) return;
          if (leaseRemaining <= 0) return { error: 'lookup_failed' } as const;
          const timeRemaining = Math.min(leaseRemaining, retryRemaining);
          await boundDispatchWaits(tx, dispatchDeadline);
          const secrets = await tx.webhookSecret.findMany({
            where: { endpointId: endpoint.id, ...activeWebhookSecrets(signingTime) },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take: MAX_WEBHOOK_SIGNATURES + 1,
            select: { ciphertext: true },
          });
          if (secrets.length > MAX_WEBHOOK_SIGNATURES && !current.secretOverlapWarnedAt) warnOverlap(signingTime);
          const timestamp = Math.floor(+signingTime / 1000);
          let signature: string;
          try {
            const keys = secrets.slice(0, MAX_WEBHOOK_SIGNATURES).map(({ ciphertext }) => decryptWebhookSecret(ciphertext, options.secretKey));
            signature = await signWebhook({ id: webhookId, timestamp, payload: body, secrets: keys });
          } catch {
            return { error: 'signing_failed' } as const;
          }
          // Account for time spent preparing the signature without relying on the worker's wall clock.
          if (performance.now() - clockStarted >= timeRemaining)
            return leaseRemaining <= retryRemaining ? ({ error: 'lookup_failed' } as const) : undefined;
          if (performance.now() >= dispatchDeadline) return { error: 'lookup_failed' } as const;
          // Start under the locks so Prisma can release them without waiting for the receiver.
          return startRequest(timestamp, signature);
        },
        { timeout: DISPATCH_TX_TIMEOUT_MS },
      ),
    options.transport,
  );
}

async function boundDispatchWaits(tx: Prisma.TransactionClient, deadline: number) {
  const remaining = Math.floor(deadline - performance.now());
  if (remaining <= 0) throw new Error('Webhook dispatch budget expired');
  // set_config(..., true) is the parameterized form of SET LOCAL. Prisma's timeout cannot cancel an active SQL statement.
  const timeout = `${remaining}ms`;
  await tx.$queryRaw`SELECT set_config('lock_timeout', ${timeout}, true), set_config('statement_timeout', ${timeout}, true)`;
}

async function warnSecretOverlap(endpoint: WebhookEndpoint, overlapAt: Date) {
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

async function sendClaim(ch: ClickHouseClient, claim: Claim, options: DeliveryOptions) {
  const { delivery, expired, leaseDeadline } = claim;
  const start = performance.now();
  let endpoint: WebhookEndpoint | null | undefined;
  let result: DeliveryResult | undefined;
  let overlapAt: Date | undefined;
  try {
    endpoint = await prisma.webhookEndpoint.findUnique({ where: { id: delivery.endpointId } });
    if (endpoint?.enabled && !endpoint.filterReviewRequired) {
      const scope = storedWebhookScope(endpoint);
      if (scope !== undefined) {
        if (expired) return settle(delivery, endpoint, undefined, 0, options.failureLimit);
        result = await attemptDelivery(ch, claim, endpoint, scope, options, (time) => {
          overlapAt = time;
        });
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
  const latencyMs = Math.round(performance.now() - start);
  const acquireBy = leaseDeadline - SETTLE_TX_TIMEOUT_MS - SETTLE_LEASE_MARGIN_MS;
  for (let backoff = 100; ; backoff = Math.min(backoff * 2, SETTLE_MAX_BACKOFF_MS)) {
    const maxWait = Math.min(SETTLE_MAX_WAIT_MS, Math.floor(acquireBy - performance.now()));
    if (maxWait <= 0) break;
    try {
      await settle(delivery, endpoint, result, latencyMs, options.failureLimit, maxWait);
      if (endpoint && overlapAt) await warnSecretOverlap(endpoint, overlapAt);
      return;
    } catch {
      // Retry this result under the same delivery lease and sequence.
    }
    if (performance.now() + backoff >= acquireBy) break;
    await delay(backoff);
  }
  console.error(
    JSON.stringify({
      level: 'error',
      event: 'webhook.settlement_failed',
      endpointId: delivery.endpointId,
      deliveryId: delivery.id,
      attemptNumber: delivery.attemptNumber,
      responseCode: result.responseCode,
      error: result.error,
      leaseUntil: delivery.leaseUntil,
    }),
  );
}

export async function deliverWebhooks(ch: ClickHouseClient, options: DeliveryOptions, projectId?: string | readonly string[]) {
  const claims = await claimWebhookDeliveries(options, projectId);
  const results = await Promise.allSettled(claims.map((claim) => sendClaim(ch, claim, options)));
  for (const [index, result] of results.entries()) {
    if (result.status === 'rejected') console.error(JSON.stringify({ event: 'webhook.delivery_failed', deliveryId: claims[index]?.delivery.id }));
  }
}
