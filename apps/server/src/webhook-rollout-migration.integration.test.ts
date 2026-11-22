import { readFile } from 'node:fs/promises';
import { type Prisma, prisma } from '@logbird/database';
import { expect, it } from 'vitest';

const rolloutName = '20261122140000_webhook_deliveries';
const repairName = '20261122150000_webhook_rollout_utc';
const originalCursorRepairName = '20261122160000_webhook_repair_original_cursor';
const migration = async (name: string) =>
  (await readFile(new URL(`../../../packages/database/prisma/migrations/${name}/migration.sql`, import.meta.url), 'utf8'))
    .replace(/^\s*--.*$/gm, '')
    .split(';')
    .map((query) => query.trim())
    .filter((query) => query && query !== 'BEGIN' && query !== 'COMMIT');

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
