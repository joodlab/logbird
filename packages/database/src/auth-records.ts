import { setTimeout as pause } from 'node:timers/promises';
import { Prisma, prisma } from './index';

/**
 * Scheduled cleanup of expired authentication records (#129). better-auth deletes an expired session or sign-in code
 * only when it next looks it up, so rows nobody looks up again (abandoned sessions with their IP address and user
 * agent; codes requested for addresses that never signed in, including ones `AUTH_SIGNUP=restricted` refused) would
 * otherwise stay forever. The worker runs this hourly in bounded batches.
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

/** Each batch runs under a short statement timeout, so one slow statement can't hold row locks for long. */
export const AUTH_RECORD_SWEEP_GUARD = Prisma.sql`SELECT set_config('statement_timeout','5s',true), set_config('jit','off',true)`;

/** One bounded batch: the oldest expired rows, skipping rows another transaction holds (e.g. a sign-in in progress). */
export function authRecordBatchSql(kind: AuthRecordKind, cutoff: Date) {
  const table = Prisma.raw(`"${kind}"`);
  return Prisma.sql`WITH expired AS MATERIALIZED
    (SELECT "id" FROM ${table} WHERE "expiresAt" < ${cutoff}
     ORDER BY "expiresAt" LIMIT ${AUTH_RECORD_SWEEP_BATCH_SIZE} FOR UPDATE SKIP LOCKED)
    DELETE FROM ${table} AS t USING expired WHERE t."id" = expired."id"`;
}

export interface AuthRecordSweepResult {
  removed: Record<AuthRecordKind, number>;
  batches: number;
  /** True when the time budget ran out before every kind was drained; the next run continues. */
  limited: boolean;
}

export async function sweepExpiredAuthRecords(now = Date.now()): Promise<AuthRecordSweepResult> {
  const started = Date.now();
  const removed: Record<AuthRecordKind, number> = { session: 0, verification: 0, invitation: 0 };
  let batches = 0;
  for (const kind of KINDS) {
    const cutoff = new Date(now - AUTH_RECORD_GRACE_MS[kind]);
    for (;;) {
      if (Date.now() - started >= AUTH_RECORD_SWEEP_BUDGET_MS) return { removed, batches, limited: true };
      const count = await prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw(AUTH_RECORD_SWEEP_GUARD);
          return tx.$executeRaw(authRecordBatchSql(kind, cutoff));
        },
        { maxWait: 1000, timeout: 6000 },
      );
      removed[kind] += count;
      batches++;
      if (count < AUTH_RECORD_SWEEP_BATCH_SIZE) break;
      await pause(10);
    }
  }
  return { removed, batches, limited: false };
}
