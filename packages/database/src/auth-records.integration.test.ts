import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { AUTH_RECORD_GRACE_MS, type AuthRecordSweepDb, prisma, sweepExpiredAuthRecords } from './index';

/**
 * Runs against the real Postgres in DATABASE_URL (shared in development), but never touches its auth tables: the
 * sweep runs in a private schema holding copies of `session`, `verification` and `invitation` (same columns, defaults
 * and indexes, no foreign keys), so neither another developer's rows, better-auth's own cleanup during a concurrent
 * sign-in, nor a running worker's hourly sweep can interfere. The schema is dropped afterwards; schemas left by a killed
 * run (`qa_129_*`) are dropped first.
 */
const schema = `qa_129_${randomUUID().replaceAll('-', '')}`;
const now = Date.now();
const at = (msFromNow: number) => new Date(now + msFromNow);
const KINDS = ['session', 'verification', 'invitation'] as const;

/** Runs each sweep batch with the private schema first on the search path, so its unqualified table names resolve there. */
const isolated: AuthRecordSweepDb = {
  $transaction: (run, options) =>
    prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${schema}"`);
      return run(tx);
    }, options),
};

async function dropStaleSchemas() {
  const stale = await prisma.$queryRaw<{ name: string }[]>`SELECT nspname AS name FROM pg_namespace WHERE nspname LIKE 'qa\\_129\\_%'`;
  for (const { name } of stale) await prisma.$executeRawUnsafe(`DROP SCHEMA "${name}" CASCADE`);
}

beforeAll(async () => {
  await dropStaleSchemas();
  const [row] = await prisma.$queryRaw<{ base: string }[]>`SELECT current_schema() AS base`;
  const base = row?.base ?? 'public';
  await prisma.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
  for (const kind of KINDS) await prisma.$executeRawUnsafe(`CREATE TABLE "${schema}"."${kind}" (LIKE "${base}"."${kind}" INCLUDING ALL)`);
}, 60_000);

afterAll(async () => {
  await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await prisma.$disconnect();
}, 60_000);

const ids = async (kind: (typeof KINDS)[number]) =>
  (await prisma.$queryRawUnsafe<{ id: string }[]>(`SELECT "id" FROM "${schema}"."${kind}" ORDER BY "id"`)).map((row) => row.id);

it('deletes only records past expiry plus grace, and keeps live and recently expired ones', { timeout: 120_000 }, async () => {
  const insert = (sql: string, ...values: unknown[]) => prisma.$executeRawUnsafe(sql.replaceAll('$schema', schema), ...values);
  const sessions = {
    expiredLongAgo: at(-AUTH_RECORD_GRACE_MS.session - 60_000),
    withinGrace: at(-60_000),
    live: at(86_400_000),
  };
  for (const [label, expiresAt] of Object.entries(sessions))
    await insert(
      `INSERT INTO "$schema"."session" ("id","token","userId","expiresAt","updatedAt","ipAddress","userAgent") VALUES ($1,$1,'qa-user',$2,now(),'192.0.2.10','QA')`,
      `session-${label}`,
      expiresAt,
    );
  const codes = {
    expiredLongAgo: at(-AUTH_RECORD_GRACE_MS.verification - 60_000),
    withinGrace: at(-60_000),
    live: at(600_000),
  };
  for (const [label, expiresAt] of Object.entries(codes))
    await insert(
      `INSERT INTO "$schema"."verification" ("id","identifier","value","expiresAt","updatedAt") VALUES ($1,$2,'hashed',$3,now())`,
      `code-${label}`,
      `sign-in-otp-qa-${label}@example.test`,
      expiresAt,
    );
  const invitations = {
    expiredLongAgo: { expiresAt: at(-AUTH_RECORD_GRACE_MS.invitation - 60_000), status: 'pending' },
    acceptedLongAgo: { expiresAt: at(-AUTH_RECORD_GRACE_MS.invitation - 60_000), status: 'accepted' },
    withinGrace: { expiresAt: at(-86_400_000), status: 'pending' },
    live: { expiresAt: at(2 * 86_400_000), status: 'pending' },
  };
  for (const [label, { expiresAt, status }] of Object.entries(invitations))
    await insert(
      `INSERT INTO "$schema"."invitation" ("id","organizationId","email","role","status","expiresAt","inviterId") VALUES ($1,'qa-org',$2,'member',$3,$4,'qa-user')`,
      `invite-${label}`,
      `qa-invitee-${label}@example.test`,
      status,
      expiresAt,
    );

  const result = await sweepExpiredAuthRecords(now, isolated);
  expect(result).toEqual({ removed: { session: 1, verification: 1, invitation: 2 }, batches: 3, limited: false });
  expect({ session: await ids('session'), verification: await ids('verification'), invitation: await ids('invitation') }).toEqual({
    session: ['session-live', 'session-withinGrace'],
    verification: ['code-live', 'code-withinGrace'],
    invitation: ['invite-live', 'invite-withinGrace'],
  });

  // A second run finds nothing more to do.
  expect((await sweepExpiredAuthRecords(now, isolated)).removed).toEqual({ session: 0, verification: 0, invitation: 0 });
});
