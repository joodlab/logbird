import { randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import { afterAll, expect, it } from 'vitest';
import { PrismaClient } from './generated/client';
import { isUniqueViolation, prisma } from './index';
import { keys } from './keys';

// Proves the helper against the error shape the real Prisma client + adapter-pg produce for a raw-query unique
// violation (the shape claimIngestReceipts sees during REINDEX CONCURRENTLY). Raises the SQLSTATE without writing rows.
afterAll(() => prisma.$disconnect());

it('recognizes a real raw-query unique violation from Prisma', async () => {
  const error = await prisma.$queryRaw`DO $$ BEGIN RAISE unique_violation USING MESSAGE = 'qa unique violation'; END $$`.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).not.toBeNull();
  expect(isUniqueViolation(error)).toBe(true);
});

it('recognizes a real executeRaw unique violation and rejects other SQLSTATEs', async () => {
  const unique = await prisma.$executeRaw`DO $$ BEGIN RAISE unique_violation USING MESSAGE = 'qa unique violation'; END $$`.then(
    () => null,
    (e: unknown) => e,
  );
  expect(isUniqueViolation(unique)).toBe(true);
  const other = await prisma.$queryRaw`DO $$ BEGIN RAISE query_canceled USING MESSAGE = 'qa cancel'; END $$`.then(
    () => null,
    (e: unknown) => e,
  );
  expect(other).not.toBeNull();
  expect(isUniqueViolation(other)).toBe(false);
});

it('recognizes a real model-query statement timeout through Prisma 7 adapter-pg', async () => {
  const schema = `qa_receipt_error_${Date.now()}_${randomUUID().replaceAll('-', '')}`;
  const projectId = `qa-receipt-timeout-${randomUUID()}`;
  const table = `"${schema}"."IngestReceipt"`;
  const writer = new pg.Client({ connectionString: keys().DATABASE_URL, connectionTimeoutMillis: 5000 });
  const isolated = new PrismaClient({ adapter: new PrismaPg({ connectionString: keys().DATABASE_URL, max: 1 }, { schema }) });
  let connected = false;
  let created = false;
  try {
    await writer.connect();
    connected = true;
    await writer.query('SET statement_timeout = 5000');
    await writer.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    // Only deleteMany's key columns are needed. No shared tables, foreign keys or real rows are involved.
    await writer.query(`CREATE TABLE ${table} ("projectId" text, "eventId" text, PRIMARY KEY ("projectId", "eventId"))`);
    await writer.query(`INSERT INTO ${table} VALUES ($1, 'qa-timeout-event')`, [projectId]);
    await writer.query('BEGIN');
    await writer.query(`SELECT * FROM ${table} WHERE "projectId"=$1 FOR UPDATE`, [projectId]);
    // A 1 ms timeout on an empty indexed seek can succeed. This private row lock makes the MODEL query wait
    // deterministically; the raw SET completes before deleteMany starts its own 50 ms statement budget.
    const error = await isolated
      .$transaction(async (tx) => {
        await tx.$executeRaw`SET LOCAL lock_timeout = '0'`;
        await tx.$executeRaw`SET LOCAL statement_timeout = '50ms'`;
        await tx.ingestReceipt.deleteMany({ where: { projectId } });
      })
      .then(
        () => null,
        (failure: unknown) => failure,
      );
    expect(error).toMatchObject({
      code: 'P2039',
      meta: { modelName: 'IngestReceipt', driverAdapterError: { cause: { kind: 'postgres', originalCode: '57014' } } },
    });
    // apps/server/src/ingest-receipt-errors.test.ts classifies exactly this pinned shape (P2039 + 57014) as infrastructure.
    const observed = error as { code: string; meta: unknown };
    console.info(JSON.stringify({ event: 'qa.receipt_model_timeout_shape', code: observed.code, meta: observed.meta }));
  } finally {
    try {
      try {
        if (connected) await writer.query('ROLLBACK');
      } finally {
        await isolated.$disconnect();
        if (created) await writer.query(`DROP SCHEMA "${schema}" CASCADE`);
      }
    } finally {
      await writer.end();
    }
  }
});
