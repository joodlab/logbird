import { readFile } from 'node:fs/promises';
import { type Prisma, prisma } from '@logbird/database';
import { webhookCursorClock, webhookCursorNeedsReview } from '@logbird/database/webhooks';
import { expect, it } from 'vitest';
import { loadWebhookReconciliation } from './webhook-reconciliation-fixture';

const rolloutName = '20261122140000_webhook_deliveries';
const repairName = '20261122150000_webhook_rollout_utc';
const originalCursorRepairName = '20261122160000_webhook_repair_original_cursor';
const reconciliationName = '20261122190000_webhook_reconciliation';
const filterReviewName = '20261122200000_webhook_filter_review';
const migration = async (name: string) =>
  (await readFile(new URL(`../../../packages/database/prisma/migrations/${name}/migration.sql`, import.meta.url), 'utf8'))
    .replace(/^\s*--.*$/gm, '')
    .split(';')
    .map((query) => query.trim())
    .filter((query) => query && query !== 'BEGIN' && query !== 'COMMIT');

it('holds every non-empty legacy filter without changing its cursor and defaults new endpoints to ready', async () => {
  const filters = ['record:site:12', String.raw`tag:team\*`, String.raw`line:"a\rb"`, 'number:1e-7', ''];
  const queries = await migration(filterReviewName);
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`CREATE TEMP TABLE "WebhookEndpoint" (
      "filterQuery" text NOT NULL, "cursorReceivedAt" timestamp(3) NOT NULL
    ) ON COMMIT DROP`;
    const cursor = new Date('2026-11-01T12:00:00Z');
    for (const filter of filters) await tx.$executeRaw`INSERT INTO "WebhookEndpoint" VALUES (${filter}, ${cursor})`;
    for (const query of queries) await tx.$executeRawUnsafe(query);
    await tx.$executeRaw`INSERT INTO "WebhookEndpoint" ("filterQuery", "cursorReceivedAt") VALUES ('action:qa.new', ${cursor})`;
    const rows = await tx.$queryRaw`SELECT * FROM "WebhookEndpoint"`;
    expect(rows).toHaveLength(6);
    expect(rows).toEqual(
      expect.arrayContaining(
        [...filters, 'action:qa.new'].map((filterQuery, index) => ({
          filterQuery,
          cursorReceivedAt: cursor,
          filterReviewRequired: index < 4,
          filterReviewNoticeClaimedAt: null,
        })),
      ),
    );
  });
});

it.each(['Pacific/Auckland', 'America/Los_Angeles'])('repairs untouched webhook rollout cursors in PostgreSQL session %s', async (zone) => {
  const [original, correction, originalCursorRepair] = await Promise.all([
    migration(rolloutName),
    migration(repairName),
    migration(originalCursorRepairName),
  ]);
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('TimeZone', ${zone}, true)`;
    await tx.$executeRaw`CREATE TEMP TABLE "WebhookEndpoint" (
      id text PRIMARY KEY, enabled boolean DEFAULT true, "createdAt" timestamp(3) DEFAULT CURRENT_TIMESTAMP
    ) ON COMMIT DROP`;
    await tx.$executeRaw`CREATE TEMP TABLE "_prisma_migrations" (
      migration_name text, started_at timestamptz, finished_at timestamptz, rolled_back_at timestamptz
    ) ON COMMIT DROP`;
    await tx.$executeRaw`INSERT INTO "WebhookEndpoint" (id, "createdAt")
      SELECT id, (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') - interval '1 minute'
      FROM unnest(ARRAY['qa-untouched', 'qa-scanned', 'qa-test-ping', 'qa-paged', 'qa-delivery', 'qa-advanced-empty']) AS ids(id)`;
    for (const query of original) {
      // Run the real DDL on temp tables that shadow the development schema.
      const sql = query.startsWith('CREATE TABLE') ? `${query.replace('CREATE TABLE', 'CREATE TEMP TABLE')} ON COMMIT DROP` : query;
      await tx.$executeRawUnsafe(sql);
    }
    await tx.$executeRaw`INSERT INTO "_prisma_migrations" VALUES (${rolloutName}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, NULL)`;
    await tx.$executeRaw`UPDATE "WebhookEndpoint" SET "lastScannedAt" = CURRENT_TIMESTAMP WHERE id = 'qa-scanned'`;
    await tx.$executeRaw`UPDATE "WebhookEndpoint" SET "cursorEventId" = 'qa-page' WHERE id = 'qa-paged'`;
    await tx.$executeRaw`UPDATE "WebhookEndpoint"
      SET "cursorReceivedAt" = "cursorReceivedAt" + interval '5 minutes', "lastScannedAt" = CURRENT_TIMESTAMP WHERE id = 'qa-advanced-empty'`;
    await tx.$executeRaw`INSERT INTO "WebhookDelivery" (id, "endpointId", "eventId", "receivedAt", "expiresAt")
      VALUES ('qa-delivery', 'qa-delivery', 'qa-event', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
             ('qa-test-ping', 'qa-test-ping', 'qa-test', NULL, CURRENT_TIMESTAMP)`;
    await tx.$executeRaw`INSERT INTO "WebhookEndpoint" (id) VALUES ('qa-created-after-rollout')`;
    const cursors = (db: Prisma.TransactionClient) => db.$queryRaw<{ id: string; seconds: number }[]>`
      SELECT id, extract(epoch FROM ("cursorReceivedAt" - (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')))::float8 seconds
      FROM "WebhookEndpoint" ORDER BY id`;
    const before = await cursors(tx);
    expect(before).toHaveLength(7);
    expect(before.every(({ seconds }) => Math.abs(seconds) > 3600)).toBe(true);
    for (const query of correction) await tx.$executeRawUnsafe(query);
    const after = await cursors(tx);
    expect(after.filter(({ id }) => id !== 'qa-untouched')).toEqual(before.filter(({ id }) => id !== 'qa-untouched'));
    expect(after.find(({ id }) => id === 'qa-untouched')?.seconds).toBeCloseTo(0, 2);
    const update = correction.find((query) => query.startsWith('UPDATE'));
    if (!update) throw new Error('Missing cursor repair');
    expect(await tx.$executeRawUnsafe(update)).toBe(0);
    for (const query of originalCursorRepair) await tx.$executeRawUnsafe(query);
    const recovered = await cursors(tx);
    const shouldRepair = new Set(['qa-scanned', 'qa-test-ping']);
    expect(recovered.filter(({ id }) => !shouldRepair.has(id))).toEqual(after.filter(({ id }) => !shouldRepair.has(id)));
    for (const { id, seconds } of recovered) if (shouldRepair.has(id)) expect(seconds).toBeCloseTo(0, 2);
    for (const query of originalCursorRepair) expect(await tx.$executeRawUnsafe(query)).toBe(0);
    await tx.$executeRaw`INSERT INTO "WebhookEndpoint" (id) VALUES ('qa-new-default')`;
    expect((await cursors(tx)).find(({ id }) => id === 'qa-new-default')?.seconds).toBeCloseTo(0, 2);
    await tx.$executeRaw`INSERT INTO "WebhookDelivery" (id, "endpointId", "eventId", "expiresAt")
      VALUES ('qa-new-delivery', 'qa-new-default', 'qa-new-event', CURRENT_TIMESTAMP)`;
    await tx.$executeRaw`INSERT INTO "WebhookDisableNotice" (id, "endpointId", "recipientId", reason)
      VALUES ('qa-new-notice', 'qa-new-default', 'qa-recipient', 'qa-disabled')`;
    const deadlines = await tx.$queryRaw<{ created: number; due: number }[]>`
      SELECT extract(epoch FROM ("createdAt" - (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')))::float8 created,
             extract(epoch FROM ("nextAttemptAt" - (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')))::float8 due
      FROM (SELECT "createdAt", "nextAttemptAt" FROM "WebhookDelivery" WHERE id = 'qa-new-delivery'
            UNION ALL SELECT "createdAt", "nextAttemptAt" FROM "WebhookDisableNotice" WHERE id = 'qa-new-notice') AS clocks`;
    expect(deadlines).toHaveLength(2);
    for (const clock of deadlines) {
      expect(clock.created).toBeCloseTo(0, 2);
      expect(clock.due).toBeCloseTo(0, 2);
    }
  });
});

it.each(['Pacific/Auckland', 'America/Los_Angeles'])('detects a stranded rollout cursor after a table rewrite in %s', async (zone) => {
  const [repair, reconciliation] = await Promise.all([migration(originalCursorRepairName), migration(reconciliationName)]);
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('TimeZone', ${zone}, true)`;
    await tx.$executeRaw`CREATE TEMP TABLE "WebhookEndpoint" (
      id text PRIMARY KEY, "createdAt" timestamp(3), "cursorEventId" text, "lastScannedAt" timestamp(3)
    ) ON COMMIT DROP`;
    await tx.$executeRaw`CREATE TEMP TABLE "WebhookDelivery" ("endpointId" text, "receivedAt" timestamp(3)) ON COMMIT DROP`;
    await tx.$executeRaw`CREATE TEMP TABLE "_prisma_migrations" (
      migration_name text, started_at timestamptz, finished_at timestamptz, rolled_back_at timestamptz
    ) ON COMMIT DROP`;
    await tx.$executeRaw`INSERT INTO "_prisma_migrations" VALUES (
      ${rolloutName}, CURRENT_TIMESTAMP - interval '2 days', CURRENT_TIMESTAMP - interval '2 days', NULL
    )`;
    await tx.$executeRaw`INSERT INTO "WebhookEndpoint" VALUES (
      'qa-rewritten', (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') - interval '3 days', NULL,
      (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') - interval '2 days' + interval '5 minutes'
    )`;
    await tx.$executeRaw`ALTER TABLE "WebhookEndpoint" ADD COLUMN "cursorReceivedAt" timestamp(3)
      NOT NULL DEFAULT (CURRENT_TIMESTAMP - interval '2 days')`;
    await tx.$executeRaw`ALTER TABLE "WebhookEndpoint" ALTER COLUMN "cursorReceivedAt" TYPE timestamp(3)
      USING ("cursorReceivedAt" + interval '0 seconds')`;
    expect(
      await tx.$queryRaw`SELECT atthasmissing FROM pg_attribute
      WHERE attrelid = '"WebhookEndpoint"'::regclass AND attname = 'cursorReceivedAt'`,
    ).toEqual([{ atthasmissing: false }]);
    for (const sql of repair) expect(await tx.$executeRawUnsafe(sql)).toBe(0);
    for (const sql of reconciliation) await tx.$executeRawUnsafe(sql);
    const clock = await webhookCursorClock(tx);
    const [stranded] = await tx.$queryRaw<Parameters<typeof webhookCursorNeedsReview>[0][]>`
      SELECT "createdAt", "cursorReceivedAt", "cursorEventId", "cursorVerifiedFloor", "lastScannedAt" FROM "WebhookEndpoint"`;
    if (!stranded) throw new Error('Missing restored cursor fixture');
    expect(+stranded.cursorReceivedAt).toBeLessThan(+clock.now);
    expect(webhookCursorNeedsReview(stranded, clock)).toBe(true);
    expect(webhookCursorNeedsReview({ ...stranded, cursorReceivedAt: clock.rollout }, clock)).toBe(false);
  });
});

it('rewinds a held cursor and only moves a below-floor cursor up to its starting bound', async () => {
  const [reconciliation, reconcile] = await Promise.all([migration(reconciliationName), loadWebhookReconciliation()]);
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL TIME ZONE 'Pacific/Auckland'`;
    await tx.$executeRaw`CREATE TEMP TABLE "WebhookEndpoint" (
      id text PRIMARY KEY, "projectId" text, "createdAt" timestamp(3), "updatedAt" timestamp(3),
      "cursorReceivedAt" timestamp(3), "cursorEventId" text, "lastScannedAt" timestamp(3), "cursorReviewRequired" boolean
    ) ON COMMIT DROP`;
    await tx.$executeRaw`CREATE TEMP TABLE "Project" (id text PRIMARY KEY, "organizationId" text) ON COMMIT DROP`;
    await tx.$executeRaw`CREATE TEMP TABLE "AuditOutbox" (LIKE public."AuditOutbox" INCLUDING DEFAULTS) ON COMMIT DROP`;
    await tx.$executeRaw`CREATE TEMP TABLE "_prisma_migrations" (
      migration_name text, started_at timestamptz, finished_at timestamptz, rolled_back_at timestamptz
    ) ON COMMIT DROP`;
    await tx.$executeRaw`INSERT INTO "_prisma_migrations" VALUES (${rolloutName}, '2026-10-02 14:00:00+00', '2026-10-02 14:00:01+00', NULL)`;
    await tx.$executeRaw`INSERT INTO "Project" VALUES ('qa-project', 'qa-org')`;
    await tx.$executeRaw`INSERT INTO "WebhookEndpoint" VALUES (
      'qa-rebuilt', 'qa-project', '2026-09-30 12:00:00', '2026-10-01 15:02:00',
      '2026-10-01 15:02:00', 'qa-old-position', '2026-10-01 15:02:00', true
    )`;
    for (const sql of reconciliation) await tx.$executeRawUnsafe(sql);
    const clock = await webhookCursorClock(tx);
    expect(clock.rollout.toISOString()).toBe('2026-10-02T14:00:00.000Z');
    const endpoint = async () => {
      const [row] = await tx.$queryRaw<(Parameters<typeof webhookCursorNeedsReview>[0] & { cursorReviewRequired: boolean })[]>`
        SELECT * FROM "WebhookEndpoint"`;
      if (!row) throw new Error('Missing rebuilt-ledger fixture');
      return row;
    };
    expect(webhookCursorNeedsReview(await endpoint(), clock)).toBe(true);
    const floor = new Date('2026-10-01T14:00:00.000Z');
    const rewind = new Date('2026-10-01T15:01:00.000Z');
    expect(await reconcile(tx, 'qa-rebuilt', 'qa-unrelated', floor, rewind)).toEqual([]);
    expect(await reconcile(tx, 'qa-rebuilt', 'qa-project', floor, new Date('2026-10-01T15:03:00.000Z'))).toEqual([]);
    expect(await reconcile(tx, 'qa-rebuilt', 'qa-project', floor, rewind)).toHaveLength(1);
    expect(await reconcile(tx, 'qa-rebuilt', 'qa-project', floor, rewind)).toEqual([]);
    const restored = await endpoint();
    expect(restored).toMatchObject({
      cursorReceivedAt: rewind,
      cursorEventId: null,
      cursorReviewRequired: false,
      cursorVerifiedFloor: floor,
      lastScannedAt: new Date('2026-10-01T15:02:00.000Z'),
    });
    expect(webhookCursorNeedsReview(restored, clock)).toBe(false);
    expect(webhookCursorNeedsReview({ ...restored, cursorReceivedAt: new Date('2026-10-01T13:59:59.999Z') }, clock)).toBe(true);
    expect(webhookCursorNeedsReview({ ...restored, createdAt: new Date('2026-10-01T15:03:00.000Z') }, clock)).toBe(true);
    expect(await tx.$queryRaw`SELECT stream, namespace, payload FROM "AuditOutbox"`).toMatchObject([
      { stream: 'ws:qa-org', namespace: '{logbird-t2w}', payload: { action: 'webhook.cursor_reconciled', metadata: { evidenceRef: 'qa-backup' } } },
    ]);

    // Endpoint creation is later than the original rollout, so it defines the starting bound.
    const start = new Date('2026-10-01T14:30:00.000Z');
    const belowStart = new Date(+floor - 1);
    await tx.$executeRaw`UPDATE "WebhookEndpoint"
      SET "createdAt" = (${start.toISOString()}::timestamptz AT TIME ZONE 'UTC'),
          "cursorReceivedAt" = (${belowStart.toISOString()}::timestamptz AT TIME ZONE 'UTC'), "cursorReviewRequired" = true`;
    expect(await reconcile(tx, 'qa-rebuilt', 'qa-project', floor, floor)).toEqual([]);
    expect(await reconcile(tx, 'qa-rebuilt', 'qa-project', floor, new Date(+start + 1))).toEqual([]);
    expect(await endpoint()).toMatchObject({ cursorReceivedAt: belowStart, cursorReviewRequired: true });
    expect(await reconcile(tx, 'qa-rebuilt', 'qa-project', floor, start)).toHaveLength(1);
    const recovered = await endpoint();
    expect(recovered).toMatchObject({ cursorReceivedAt: start, cursorVerifiedFloor: floor, cursorReviewRequired: false });
    expect(webhookCursorNeedsReview(recovered, clock)).toBe(false);
  });
});
