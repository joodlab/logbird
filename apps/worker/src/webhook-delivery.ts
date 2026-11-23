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
  /** Internal: statement timeout of each claim statement, including the fallback's endpoint listing. Default 2 s. */
  claimTimeoutMs?: number;
  /** Internal: total time one pass may spend claiming before it stops and dispatches what it has claimed. Default 10 s. */
  claimBudgetMs?: number;
  /**
   * Tests only, ignored outside Vitest: make the claim scans of these endpoints slow (with `listing`, the fallback's
   * endpoint listing too), to force statement timeouts there.
   */
  claimScanDelay?: { endpointIds: string[]; seconds: number; listing?: boolean };
  /** Tests only, ignored outside Vitest: the clock the claim budget reads (default `performance.now`). */
  claimBudgetClock?: () => number;
  /** Tests only, ignored outside Vitest: called once the fair statement's claims are collected. */
  claimAfterFair?: () => void;
};

/** The most a pass spends claiming. Normal passes take milliseconds; this bounds a pass whose statements keep timing out. */
const CLAIM_BUDGET_MS = 10_000;

const scopeWhere = ({ scopeTenantId, scopeTargetType, scopeTargetId, scopeMask }: ScopeColumns) => ({
  scopeTenantId,
  scopeTargetType,
  scopeTargetId,
  scopeMask: { equals: scopeMask },
});

// Bind UTC wall time to the timestamp columns independently of the session time zone.
const at = (time: Date) => Prisma.sql`${time.toISOString()}::timestamp`;

type PassScope = {
  now: Date;
  leaseDeadline: number;
  perEndpoint: number;
  excludeEndpoints: string[];
  timeoutMs: number;
  /** Budget-clock time after which the pass starts no further claim statement. */
  claimDeadline: number;
  budgetClock: () => number;
  scanDelay?: DeliveryOptions['claimScanDelay'];
};

const scanSleep = (scope: PassScope) =>
  scope.scanDelay
    ? Prisma.sql`AND CASE WHEN e.id = ANY(${scope.scanDelay.endpointIds}::text[]) THEN (SELECT true FROM pg_sleep(${scope.scanDelay.seconds}) WHERE e.id IS NOT NULL) ELSE true END`
    : Prisma.empty;

const eligibleEndpoint = (excludeEndpoints: string[]) => Prisma.sql`
  e.enabled AND NOT e."scopeReviewRequired" AND NOT e."filterReviewRequired" AND NOT (e.id = ANY(${excludeEndpoints}::text[]))`;

/**
 * Projects with a due, lease-free row on an eligible endpoint, in try order: least recently claimed first, with a project
 * that has never been claimed (no rotation row, as for every project right after the upgrade) before all others, then by
 * its oldest due row. One lockless query per pass; a row another transaction holds can only move its project earlier.
 */
function rankProjects(scope: PassScope, projects?: string[]) {
  const { now } = scope;
  return prisma.$queryRaw<{ projectId: string }[]>(Prisma.sql`
    SELECT e."projectId" FROM "WebhookEndpoint" e
    CROSS JOIN LATERAL (
      SELECT "nextAttemptAt" FROM "WebhookDelivery"
      WHERE "endpointId" = e.id AND status = 'pending'
        AND "nextAttemptAt" <= ${at(now)} AND ("leaseUntil" IS NULL OR "leaseUntil" <= ${at(now)})
      ORDER BY "nextAttemptAt", id LIMIT 1
    ) due
    LEFT JOIN "WebhookClaimRotation" r ON r."projectId" = e."projectId"
    WHERE ${eligibleEndpoint(scope.excludeEndpoints)}
      ${projects ? Prisma.sql`AND e."projectId" = ANY(${projects}::text[])` : Prisma.empty}
    GROUP BY e."projectId", r."lastClaimedAt"
    ORDER BY r."lastClaimedAt" NULLS FIRST, min(due."nextAttemptAt"), e."projectId"`);
}

/**
 * Rows of one project that a claim may take, already locked: for each eligible endpoint, its oldest due, lease-free rows,
 * scanned in order and skipping rows another transaction holds (`FOR UPDATE SKIP LOCKED` inside the scan), at most the
 * endpoint's room (fewer than `perEndpoint` live leases and 50 attempts per second), and at most `cap` per endpoint.
 */
function claimableRows(scope: PassScope, project: Prisma.Sql, cap?: number, endpointId?: string) {
  const { now, perEndpoint } = scope;
  const room = Prisma.sql`least(
    ${perEndpoint} - (
      SELECT count(*) FROM "WebhookDelivery" live
      WHERE live."endpointId" = e.id AND live.status = 'pending' AND live."leaseUntil" > ${at(now)}
    ),
    ${MAX_ENDPOINT_ATTEMPTS_PER_SECOND} - (
      SELECT count(*) FROM "WebhookAttempt" a JOIN "WebhookDelivery" recent ON recent.id = a."deliveryId"
      WHERE recent."endpointId" = e.id AND a."startedAt" > ${at(new Date(+now - 1000))}
    )${cap === undefined ? Prisma.empty : Prisma.sql`, ${cap}`}
  )`;
  return Prisma.sql`
    SELECT row.id, row."nextAttemptAt", row."attemptNumber" AS "previousNumber", row."leaseUntil" IS NOT NULL AS leased
    FROM "WebhookEndpoint" e
    CROSS JOIN LATERAL (
      SELECT d.* FROM "WebhookDelivery" d
      WHERE d."endpointId" = e.id AND d.status = 'pending'
        AND d."nextAttemptAt" <= ${at(now)} AND (d."leaseUntil" IS NULL OR d."leaseUntil" <= ${at(now)})
      ORDER BY d."nextAttemptAt", d.id
      LIMIT greatest(0, ${room})
      FOR UPDATE SKIP LOCKED
    ) row
    WHERE e."projectId" = ${project} AND ${eligibleEndpoint(scope.excludeEndpoints)}
      ${endpointId ? Prisma.sql`AND e.id = ${endpointId}` : Prisma.empty}
      ${scanSleep(scope)}`;
}

/**
 * Claim up to `limit` of one project's oldest claimable rows in one short transaction: pending, due, lease free, not held
 * by another transaction (`FOR UPDATE … SKIP LOCKED`), on an enabled endpoint without a scope or filter hold, and within
 * each endpoint's room (fewer than `perEndpoint` live leases and 50 attempts per second). The same statement takes the
 * leases, writes the attempts and records the project's claim time for the rotation. An expired row only takes the lease,
 * so the claimant can settle its ended retry window without a new attempt.
 */
async function claimProject(scope: PassScope, projectId: string, limit: number, endpointId?: string): Promise<Claim[]> {
  const { now, leaseDeadline } = scope;
  const [, rows] = await prisma.$transaction([
    prisma.$queryRaw`SELECT set_config('lock_timeout', '1s', true), set_config('statement_timeout', ${`${scope.timeoutMs}ms`}, true)`,
    prisma.$queryRaw<(WebhookDelivery & { expired: boolean })[]>(Prisma.sql`
      WITH picked AS (
        SELECT id, "previousNumber", leased FROM (${claimableRows(scope, Prisma.sql`${projectId}`, undefined, endpointId)}) candidates
        ORDER BY "nextAttemptAt", id LIMIT ${limit}
      ),
      interrupted AS (
        UPDATE "WebhookAttempt" a SET status = 'interrupted' FROM picked p
        WHERE p.leased AND a."deliveryId" = p.id AND a.number = p."previousNumber" AND a.status = 'sending'
      ),
      claimed AS (
        UPDATE "WebhookDelivery" d SET
          "leaseUntil" = ${at(new Date(+now + LEASE_MS))},
          "attemptNumber" = d."attemptNumber" + CASE WHEN d."retryUntil" <= ${at(now)} THEN 0 ELSE 1 END,
          "windowAttempts" = d."windowAttempts" + CASE WHEN d."retryUntil" <= ${at(now)} THEN 0 ELSE 1 END,
          "retryUntil" = coalesce(d."retryUntil", ${at(new Date(+now + RETRY_WINDOW_MS))})
        FROM picked p WHERE d.id = p.id
        RETURNING d.*, coalesce(d."retryUntil" <= ${at(now)}, false) AS expired
      ),
      attempt AS (
        INSERT INTO "WebhookAttempt" ("deliveryId", number, "startedAt", status)
        SELECT id, "attemptNumber", ${at(now)}, 'sending' FROM claimed WHERE NOT expired
      ),
      rotated AS (
        INSERT INTO "WebhookClaimRotation" ("projectId", "lastClaimedAt")
        SELECT ${projectId}, (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3) WHERE EXISTS (SELECT 1 FROM claimed)
        ON CONFLICT ("projectId") DO UPDATE
          SET "lastClaimedAt" = greatest("WebhookClaimRotation"."lastClaimedAt", EXCLUDED."lastClaimedAt")
      )
      SELECT * FROM claimed ORDER BY "nextAttemptAt", id`),
  ]);
  return rows.map(({ expired, ...delivery }) => ({ delivery, expired, leaseDeadline }));
}

/**
 * Fair phase in one statement and one short transaction: for each ranked project, in rank order, lock its single oldest
 * claimable row (the same conditions as `claimProject`, `FOR UPDATE … SKIP LOCKED`), keep the first `limit` of those
 * rows, and take their leases, write their attempts and record the projects' claim times together. A project with nothing
 * claimable yields no row, so it takes no slot. If the statement fails, it rolls back as a whole: no lease, no attempt and
 * no rotation change.
 */
async function claimFair(scope: PassScope, ranked: string[], limit: number): Promise<{ claims: Claim[]; projects: string[] }> {
  const { now, leaseDeadline } = scope;
  const [, rows] = await prisma.$transaction([
    prisma.$queryRaw`SELECT set_config('lock_timeout', '1s', true), set_config('statement_timeout', ${`${scope.timeoutMs}ms`}, true)`,
    prisma.$queryRaw<(WebhookDelivery & { expired: boolean; claimProjectId: string; turn: bigint })[]>(Prisma.sql`
      WITH picked AS (
        SELECT ranked."projectId", ranked.turn, first.id, first."previousNumber", first.leased
        FROM unnest(${ranked}::text[]) WITH ORDINALITY AS ranked("projectId", turn)
        CROSS JOIN LATERAL (
          SELECT * FROM (${claimableRows(scope, Prisma.sql`ranked."projectId"`, 1)}) candidates
          ORDER BY "nextAttemptAt", id LIMIT 1
        ) first
        ORDER BY ranked.turn LIMIT ${limit}
      ),
      interrupted AS (
        UPDATE "WebhookAttempt" a SET status = 'interrupted' FROM picked p
        WHERE p.leased AND a."deliveryId" = p.id AND a.number = p."previousNumber" AND a.status = 'sending'
      ),
      claimed AS (
        UPDATE "WebhookDelivery" d SET
          "leaseUntil" = ${at(new Date(+now + LEASE_MS))},
          "attemptNumber" = d."attemptNumber" + CASE WHEN d."retryUntil" <= ${at(now)} THEN 0 ELSE 1 END,
          "windowAttempts" = d."windowAttempts" + CASE WHEN d."retryUntil" <= ${at(now)} THEN 0 ELSE 1 END,
          "retryUntil" = coalesce(d."retryUntil", ${at(new Date(+now + RETRY_WINDOW_MS))})
        FROM picked p WHERE d.id = p.id
        RETURNING d.*, coalesce(d."retryUntil" <= ${at(now)}, false) AS expired, p."projectId" AS "claimProjectId", p.turn
      ),
      attempt AS (
        INSERT INTO "WebhookAttempt" ("deliveryId", number, "startedAt", status)
        SELECT id, "attemptNumber", ${at(now)}, 'sending' FROM claimed WHERE NOT expired
      ),
      rotated AS (
        INSERT INTO "WebhookClaimRotation" ("projectId", "lastClaimedAt")
        SELECT "claimProjectId", (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3) FROM claimed
        ON CONFLICT ("projectId") DO UPDATE
          SET "lastClaimedAt" = greatest("WebhookClaimRotation"."lastClaimedAt", EXCLUDED."lastClaimedAt")
      )
      SELECT * FROM claimed ORDER BY turn`),
  ]);
  return {
    claims: rows.map(({ expired, claimProjectId: _project, turn: _turn, ...delivery }) => ({ delivery, expired, leaseDeadline })),
    projects: rows.map(({ claimProjectId }) => claimProjectId),
  };
}

/** A project's eligible endpoints with a due, lease-free row, by their oldest due row. At most 10 per project. */
async function projectEndpoints(scope: PassScope, projectId: string) {
  const { now } = scope;
  // The same statement timeout as the claims, so a stalled listing costs one timeout, not the pass.
  const [, rows] = await prisma.$transaction([
    prisma.$queryRaw`SELECT set_config('lock_timeout', '1s', true), set_config('statement_timeout', ${`${scope.timeoutMs}ms`}, true)`,
    prisma.$queryRaw<{ id: string }[]>(Prisma.sql`
    SELECT e.id FROM "WebhookEndpoint" e
    CROSS JOIN LATERAL (
      SELECT "nextAttemptAt" FROM "WebhookDelivery"
      WHERE "endpointId" = e.id AND status = 'pending'
        AND "nextAttemptAt" <= ${at(now)} AND ("leaseUntil" IS NULL OR "leaseUntil" <= ${at(now)})
      ORDER BY "nextAttemptAt", id LIMIT 1
    ) due
    WHERE e."projectId" = ${projectId} AND ${eligibleEndpoint(scope.excludeEndpoints)}
      ${scope.scanDelay?.listing ? scanSleep(scope) : Prisma.empty}
    ORDER BY due."nextAttemptAt", e.id`),
  ]);
  return rows.map(({ id }) => id);
}

/**
 * Record the existing scope hold (`scopeReviewRequired`, shown as `scopeWarning: webhook_invalid_scope`) without waiting:
 * if another transaction holds the endpoint row, skip the write. The endpoint stays out of this pass either way, and a
 * later pass records the hold.
 */
async function holdInvalidScope(endpointId: string, scope: ScopeColumns, updatedAt: Date) {
  try {
    const held = await prisma.$executeRaw`
      UPDATE "WebhookEndpoint" SET "scopeReviewRequired" = true
      WHERE id = (
        SELECT id FROM "WebhookEndpoint"
        WHERE id = ${endpointId} AND "updatedAt" = ${at(updatedAt)} AND NOT "scopeReviewRequired"
          AND "scopeTenantId" IS NOT DISTINCT FROM ${scope.scopeTenantId}::text
          AND "scopeTargetType" IS NOT DISTINCT FROM ${scope.scopeTargetType}::text
          AND "scopeTargetId" IS NOT DISTINCT FROM ${scope.scopeTargetId}::text
          AND "scopeMask" = ${scope.scopeMask}::text[]
        FOR UPDATE SKIP LOCKED
      )`;
    if (!held) console.warn(JSON.stringify({ event: 'webhook.scope_hold_deferred', endpointId }));
  } catch {
    console.error(JSON.stringify({ event: 'webhook.scope_hold_failed', endpointId }));
  }
}

/** Endpoints with due rows whose stored scope is invalid. Validity is checked in code, so check before any claim. */
async function invalidScopedEndpoints(now: Date, projects?: string[]) {
  const scoped = await prisma.$queryRaw<{ id: string; updatedAt: Date; scope: ScopeColumns }[]>(Prisma.sql`
    SELECT e.id, e."updatedAt", jsonb_build_object(
      'scopeTenantId', e."scopeTenantId", 'scopeTargetType', e."scopeTargetType",
      'scopeTargetId', e."scopeTargetId", 'scopeMask', e."scopeMask"
    ) AS scope
    FROM "WebhookEndpoint" e
    WHERE e.enabled AND NOT e."scopeReviewRequired" AND NOT e."filterReviewRequired"
      AND (e."scopeTenantId" IS NOT NULL OR e."scopeTargetType" IS NOT NULL OR e."scopeTargetId" IS NOT NULL OR cardinality(e."scopeMask") > 0)
      ${projects ? Prisma.sql`AND e."projectId" = ANY(${projects}::text[])` : Prisma.empty}
      AND EXISTS (
        SELECT 1 FROM "WebhookDelivery" d
        WHERE d."endpointId" = e.id AND d.status = 'pending' AND d."nextAttemptAt" <= ${at(now)}
      )`);
  return scoped.filter(({ scope }) => storedWebhookScope(scope) === undefined);
}

/**
 * Claim order (invariant). With N free slots, a pass first holds endpoints whose stored scope is invalid, then ranks the
 * projects that have a due, lease-free row once: least recently claimed first (a project never claimed before all
 * others), then by oldest due row. Fair phase: in that order, each project claims its single oldest claimable row; a
 * row another transaction holds can only move its project earlier in this order and never takes a slot, because a
 * project with nothing claimable claims nothing and the pass moves on to the next project. Fill phase: slots left after
 * every ranked project was tried go to the projects in the same order, each taking its oldest claimable rows.
 * Bound: if P projects keep a claimable row (pending, due, lease free, not locked, on an eligible endpoint below its
 * allowance A of live leases), each pass claims for the first min(N, P) of them in least recently claimed order, so every
 * one is claimed within ceil(P / N) passes, and the r-th oldest claimable row of a project within r * ceil(P / N) passes.
 * Implementation: the fair phase is one statement per pass (`claimFair`) and the fill phase claims per project. A failed
 * fair-phase statement rolls back as a whole (no lease, attempt or rotation change), and the pass then retries the fair
 * phase one project at a time. A project whose claim fails or times out is retried one endpoint at a time (at most its
 * 10 endpoints, oldest due row first), so one endpoint's scan cannot block a sibling. The fallback's endpoint listing has
 * the same statement timeout. A pass starts no claim statement after its claim budget (10 s; normal passes take
 * milliseconds), so statements that keep timing out cannot use up the dispatch budget of rows already claimed; the budget
 * typically binds only when claim statements fail or time out, outside the conditions of the bound above. Only a failure before any claim
 * (holding scopes, ranking) fails the pass. These bounds hold for row locks Logbird itself creates; see the self-hosting
 * guide for transactions held by other clients.
 */
export async function claimWebhookDeliveries(
  options: Pick<
    DeliveryOptions,
    'concurrency' | 'perEndpoint' | 'claimTimeoutMs' | 'claimBudgetMs' | 'claimScanDelay' | 'claimBudgetClock' | 'claimAfterFair'
  >,
  projectId?: string | readonly string[],
) {
  const projects = projectId === undefined ? undefined : typeof projectId === 'string' ? [projectId] : [...projectId];
  // Sample before PostgreSQL's clock so the local retry deadline is conservative and immune to host clock skew.
  const testing = process.env.VITEST === 'true';
  // The claim budget runs on the lease clock: time spent before and during claims comes out of the dispatch budget.
  const budgetClock = (testing && options.claimBudgetClock) || (() => performance.now());
  const claimDeadline = budgetClock() + (options.claimBudgetMs ?? CLAIM_BUDGET_MS);
  const leaseDeadline = performance.now() + LEASE_MS;
  const now = await webhookDatabaseTime();
  // The delivery queue's global concurrency is one. Limit each endpoint independently and exclude live leases
  // from its allowance, even after a worker restarts while some requests are still in flight.
  const liveLeases = await prisma.webhookDelivery.count({
    where: { status: 'pending', leaseUntil: { gt: now }, ...(projects ? { endpoint: { projectId: { in: projects } } } : {}) },
  });
  const capacity = options.concurrency - liveLeases;
  if (capacity <= 0) return [];
  const scope: PassScope = {
    now,
    leaseDeadline,
    perEndpoint: options.perEndpoint,
    excludeEndpoints: [],
    timeoutMs: options.claimTimeoutMs ?? 2000,
    claimDeadline,
    budgetClock,
    // The pg_sleep hook exists only for the timeout regressions; no production caller can turn it on.
    scanDelay: testing ? options.claimScanDelay : undefined,
  };
  // An endpoint with an invalid stored scope gets the existing scope hold before it can take a slot.
  for (const { id, scope: columns, updatedAt } of await invalidScopedEndpoints(now, projects)) {
    scope.excludeEndpoints.push(id);
    await holdInvalidScope(id, columns, updatedAt);
  }
  const ranked = (await rankProjects(scope, projects)).map(({ projectId: id }) => id);
  const claims: Claim[] = [];
  const claimable = new Set<string>();
  let budgetLogged = false;
  const spent = () => {
    if (scope.budgetClock() < scope.claimDeadline) return false;
    if (!budgetLogged) {
      budgetLogged = true;
      // The rest waits for the next pass; what is claimed so far is dispatched now.
      console.error(JSON.stringify({ level: 'error', event: 'webhook.claim_budget_spent', claimed: claims.length, projects: ranked.length }));
    }
    return true;
  };
  const claim = async (project: string, limit: number) => {
    if (spent()) return 0;
    try {
      const claimed = await claimProject(scope, project, limit);
      claims.push(...claimed);
      return claimed.length;
    } catch {
      // A failed claim cannot hold up the other projects; claims committed so far are still dispatched.
      console.error(JSON.stringify({ level: 'error', event: 'webhook.claim_failed', projectId: project, claimed: claims.length }));
    }
    // Retry the project one endpoint at a time, each in its own statement and with its own timeout, so an endpoint whose
    // scan fails or times out (for example behind rows another transaction holds) cannot keep its siblings from claiming.
    let count = 0;
    let endpoints: string[] = [];
    if (spent()) return count;
    try {
      endpoints = await projectEndpoints(scope, project);
    } catch {
      console.error(JSON.stringify({ level: 'error', event: 'webhook.claim_endpoints_failed', projectId: project }));
    }
    for (const endpointId of endpoints) {
      if (count >= limit || claims.length >= capacity || spent()) break;
      try {
        const claimed = await claimProject(scope, project, Math.min(limit - count, capacity - claims.length), endpointId);
        claims.push(...claimed);
        count += claimed.length;
      } catch {
        console.error(JSON.stringify({ level: 'error', event: 'webhook.claim_endpoint_failed', projectId: project, endpointId }));
      }
    }
    return count;
  };
  // Every claim statement, the first included, starts only within the budget: slow pre-claim work (clock, leases,
  // scopes, ranking) also comes out of the lease clock.
  if (!spent())
    try {
      const fair = await claimFair(scope, ranked, capacity);
      claims.push(...fair.claims);
      for (const project of fair.projects) claimable.add(project);
      if (testing) options.claimAfterFair?.();
    } catch {
      // The statement rolled back as a whole. Retry the fair phase one project at a time, so a failing project cannot
      // hold up the others in this pass.
      console.error(JSON.stringify({ level: 'error', event: 'webhook.claim_fair_failed', projects: ranked.length }));
      for (const project of ranked) {
        if (claims.length >= capacity || spent()) break;
        if (await claim(project, 1)) claimable.add(project);
      }
    }
  for (const project of ranked) {
    if (claims.length >= capacity || spent()) break;
    if (claimable.has(project)) await claim(project, capacity - claims.length);
  }
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
    const invalid = endpoint && storedWebhookScope(endpoint) === undefined ? endpoint : undefined;
    return prisma.$transaction(async (tx) => {
      // An invalid stored scope gets the existing scope hold with the release, so the row cannot take the slot again.
      // Endpoint first, then the delivery: the lock order endpoint edits use.
      if (invalid)
        await tx.webhookEndpoint.updateMany({
          where: { id: invalid.id, updatedAt: invalid.updatedAt, ...scopeWhere(invalid) },
          data: { scopeReviewRequired: true, updatedAt: invalid.updatedAt },
        });
      await interruptClaim(tx, delivery, reason);
    });
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
