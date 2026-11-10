import { setTimeout as pause } from 'node:timers/promises';
import { Prisma, prisma } from './index';
import { SWEEP_GUARD } from './ingest-receipts';

/**
 * Scheduled cleanup of expired authentication records (#129). better-auth removes expired rows only as a side effect of
 * sign-in traffic (looking up a session or a code), so when that traffic stops, abandoned sessions with their IP
 * address and user agent, codes requested for addresses that never signed in (including ones `AUTH_SIGNUP=restricted`
 * refused) and expired invitations would stay forever. This hourly sweep, in bounded batches, is the backstop that
 * bounds how long they are kept.
 *
 * - Sessions: deleted a day after they expire (they stop working at expiry; the day keeps a just-expired session
 *   visible while someone investigates a sign-in problem).
 * - Sign-in codes (`verification`): deleted an hour after they expire.
 * - Invitations: deleted 30 days after they expire, whatever their status (pending invitations stop working at
 *   expiry; accepted, rejected and canceled ones are kept for the same 30 days).
 */
export const AUTH_RECORD_SWEEP_BATCH_SIZE = 500;
export const AUTH_RECORD_SWEEP_BUDGET_MS = 20_000;
export const AUTH_RECORD_GRACE_MS = {
  session: 24 * 60 * 60 * 1000,
  verification: 60 * 60 * 1000,
  invitation: 30 * 24 * 60 * 60 * 1000,
} as const;
export type AuthRecordKind = keyof typeof AUTH_RECORD_GRACE_MS;
const KINDS = Object.keys(AUTH_RECORD_GRACE_MS) as AuthRecordKind[];

/**
 * Each batch runs under the receipt sweep's guard (`SWEEP_GUARD`): a 5 s statement timeout, so one slow statement can't
 * hold row locks for long, and planner pins, so batches walk the `expiresAt` index and a stale or bloated estimate
 * after a large drain can't turn ORDER BY/LIMIT into a full scan plus sort. One constant, so the two can't drift.
 */
export const AUTH_RECORD_SWEEP_GUARD = SWEEP_GUARD;

/** One bounded batch: the oldest expired rows, skipping rows another transaction holds (e.g. a sign-in in progress). */
export function authRecordBatchSql(kind: AuthRecordKind, cutoff: Date) {
  const table = Prisma.raw(`"${kind}"`);
  return Prisma.sql`WITH expired AS MATERIALIZED
    (SELECT "id" FROM ${table} WHERE "expiresAt" < ${cutoff.toISOString()}::timestamp
     ORDER BY "expiresAt" LIMIT ${AUTH_RECORD_SWEEP_BATCH_SIZE} FOR UPDATE SKIP LOCKED)
    DELETE FROM ${table} AS t USING expired WHERE t."id" = expired."id"`;
}

export interface AuthRecordSweepResult {
  removed: Record<AuthRecordKind, number>;
  batches: number;
  /** True when the time budget ran out before every kind was drained; the next run continues. */
  limited: boolean;
}

/** What the sweep needs from a client; tests pass one that runs each batch in an isolated schema. */
export interface AuthRecordSweepDb {
  $transaction<T>(run: (tx: Prisma.TransactionClient) => Promise<T>, options?: { maxWait?: number; timeout?: number }): Promise<T>;
}

/**
 * Deletes expired records in batches. The budget is checked between batches, so a run can overshoot it by one batch:
 * up to 1 s waiting to start its transaction (`maxWait`) plus the 6 s transaction timeout. Kinds take turns, one batch
 * each, until each is drained, so a large backlog of one kind (say sessions) can't use every run's budget and starve
 * the others.
 */
export async function sweepExpiredAuthRecords(now = Date.now(), db: AuthRecordSweepDb = prisma): Promise<AuthRecordSweepResult> {
  const started = Date.now();
  const removed: Record<AuthRecordKind, number> = { session: 0, verification: 0, invitation: 0 };
  let batches = 0;
  let pending = [...KINDS];
  while (pending.length) {
    const drained: AuthRecordKind[] = [];
    for (const kind of pending) {
      if (Date.now() - started >= AUTH_RECORD_SWEEP_BUDGET_MS) return { removed, batches, limited: true };
      const cutoff = new Date(now - AUTH_RECORD_GRACE_MS[kind]);
      const count = await db.$transaction(
        async (tx) => {
          await tx.$executeRaw(AUTH_RECORD_SWEEP_GUARD);
          return tx.$executeRaw(authRecordBatchSql(kind, cutoff));
        },
        { maxWait: 1000, timeout: 6000 },
      );
      removed[kind] += count;
      batches++;
      if (count < AUTH_RECORD_SWEEP_BATCH_SIZE) drained.push(kind);
    }
    pending = pending.filter((kind) => !drained.includes(kind));
    if (pending.length) await pause(10);
  }
  return { removed, batches, limited: false };
}
