import { readFileSync } from 'node:fs';
import { prisma } from '@logbird/database';
import { expect, it } from 'vitest';

it('replays the committed reporting migration against populated legacy shapes without touching public tables', async () => {
  const sql = readFileSync(
    new URL('../../../packages/database/prisma/migrations/20261107200000_audit_budget_generations/migration.sql', import.meta.url),
    'utf8',
  );
  const updates = sql
    .slice(sql.indexOf('UPDATE "AuthAuditBudget"'))
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
  expect(updates).toHaveLength(2);
  await prisma.$transaction(async (tx) => {
    // Session-local tables shadow the two public names only for this transaction. No shared data is updated.
    await tx.$executeRawUnsafe('CREATE TEMP TABLE "AuthAuditBudget" (LIKE public."AuthAuditBudget" INCLUDING DEFAULTS) ON COMMIT DROP');
    await tx.$executeRawUnsafe('CREATE TEMP TABLE "AuditOutbox" (id text, payload jsonb) ON COMMIT DROP');
    for (const [id, suppressed, reported] of [
      ['reported', 5, true],
      ['reopened', 7, false],
      ['truncated', 27, false],
      ['unreported', 4, false],
    ] as const)
      await tx.$executeRaw`INSERT INTO pg_temp."AuthAuditBudget" (id,"windowEnd",suppressed,reported,targets)
        VALUES (${id},now(),${suppressed},${reported},'{}'::jsonb)`;
    for (const [id, attempts, truncated] of [
      ['reopened', 5, false],
      ['truncated', 25, true],
    ] as const) {
      const targets = Array.from({ length: truncated ? 20 : 1 }, (_, i) => ({ userId: `qa-target-${i}`, attempts: truncated ? 1 : 5 }));
      await tx.$executeRaw`INSERT INTO pg_temp."AuditOutbox" (id,payload) VALUES (${`auth-suppression-${id}`},
        ${JSON.stringify({ metadata: { attempts, targets, targetsTruncated: truncated } })}::jsonb)`;
    }
    for (const update of updates) await tx.$executeRawUnsafe(update);
    const rows = await tx.$queryRaw<{ id: string; suppressed: number; reportedSuppressed: number; targetWatermarkComplete: boolean }[]>`
      SELECT id,suppressed,"reportedSuppressed","targetWatermarkComplete" FROM pg_temp."AuthAuditBudget" ORDER BY id`;
    expect(rows).toEqual([
      { id: 'reopened', suppressed: 7, reportedSuppressed: 5, targetWatermarkComplete: true },
      { id: 'reported', suppressed: 5, reportedSuppressed: 5, targetWatermarkComplete: true },
      { id: 'truncated', suppressed: 27, reportedSuppressed: 25, targetWatermarkComplete: false },
      { id: 'unreported', suppressed: 4, reportedSuppressed: 0, targetWatermarkComplete: true },
    ]);
    expect(rows.filter((r) => r.id !== 'reported').map((r) => r.suppressed - r.reportedSuppressed)).toEqual([2, 2, 4]);
  });
});
