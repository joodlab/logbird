import {
  ASYNC_INSERT_FLUSH_BOUND_MS,
  type ClickHouseClient,
  INGEST_CLAIM_LEASE_MS,
  type RollupDrift,
  retentionDriftAllowance,
  retentionMinuteDrift,
  retentionRollupDrift,
} from '@logbird/clickhouse';
import { databaseClock, type Prisma, prisma } from '@logbird/database';

/**
 * Derived-table verification for background retention (#296, round-1 finding 7, owner's ruling (d)).
 *
 * Drift is a derived table's total minus what the raw rows imply (`retentionRollupDrift`). It should be about zero at
 * all times; normal ingest moves both sides alike, and a run whose derived DELETE was skipped or killed makes it grow.
 * - `events_by_minute` (before the cutoff): read under the lock at fence B, exact, no allowance.
 * - `entities` and `attribute_keys`: read between the fences (a project scan would break fence B's time bound), with
 *   an allowance for rows that were in flight during that reading (an insert caught between its raw and its view part).
 * At completion the drift is read again: a measure that grew beyond baseline + allowance fails the run, names the
 * table and queues the project's repair. A baseline already beyond its allowance is drift from before this run (or one
 * that slipped past an earlier completion): logged after fence B, and repaired at completion, at most once per day.
 */
export const DRIFT_TABLES = {
  minute: 'events_by_minute',
  actor: 'entities',
  tenant: 'entities',
  executor: 'entities',
  target: 'entities',
  attributes: 'attribute_keys',
} as const satisfies Record<keyof RollupDrift, string>;
type Check = keyof RollupDrift;
const CHECKS = Object.keys(DRIFT_TABLES) as Check[];
/** An accepted row reaches ClickHouse within its claim lease, and an async insert flushes within this bound after it. */
const inFlightSlackMs = () => INGEST_CLAIM_LEASE_MS + ASYNC_INSERT_FLUSH_BOUND_MS;
/** The `error` prefix of the repair a baseline drift queues: the once-per-day limit looks for it. */
export const DRIFT_REPAIR_ERROR = 'Rollup drift found by retention';

export type RetentionVerification = {
  version: 1;
  /** The database-clock window of the between-fences reading. */
  window: { from: string; to: string };
  baseline: RollupDrift;
  allowance: RollupDrift;
  /** Measures whose baseline was already beyond its allowance. */
  baselineOff: Check[];
  result?: { checkedAt: string; drift: RollupDrift; grew: Check[]; repairQueued?: boolean };
};

export const tablesOf = (checks: Check[]) => [...new Set(checks.map((check) => DRIFT_TABLES[check]))];

/** The expensive reading, between the fences. */
export async function readDriftBetweenFences(ch: ClickHouseClient, projectId: string, cutoff: Date) {
  const from = await databaseClock(prisma);
  const drift = await retentionRollupDrift(ch, projectId, cutoff);
  const to = await databaseClock(prisma);
  return { from, to, drift };
}

/** At fence B, under the lock and after the settle proof: the exact minute reading and the in-flight allowance. */
export async function baselineAtFenceB(
  ch: ClickHouseClient,
  projectId: string,
  cutoff: Date,
  reading: Awaited<ReturnType<typeof readDriftBetweenFences>>,
): Promise<RetentionVerification> {
  const minute = await retentionMinuteDrift(ch, projectId, cutoff);
  const inFlight = await retentionDriftAllowance(ch, projectId, cutoff, reading.from, reading.to, inFlightSlackMs());
  const baseline = { ...reading.drift, minute };
  const allowance = { ...inFlight, minute: 0 };
  return {
    version: 1,
    window: { from: reading.from.toISOString(), to: reading.to.toISOString() },
    baseline,
    allowance,
    baselineOff: CHECKS.filter((check) => Math.abs(baseline[check]) > allowance[check]),
  };
}

export function driftGrew(verification: Pick<RetentionVerification, 'baseline' | 'allowance'>, now: RollupDrift) {
  return CHECKS.filter((check) => now[check] > verification.baseline[check] + verification.allowance[check]);
}

/** A stored verification, or null: a run from before the column (or any unreadable value) is never "verified". */
export function readVerification(value: unknown): RetentionVerification | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Partial<RetentionVerification>;
  if (v.version !== 1 || !v.baseline || !v.allowance || !Array.isArray(v.baselineOff)) return null;
  return v as RetentionVerification;
}

export function logBaselineDrift(projectId: string, runId: string, verification: RetentionVerification) {
  if (!verification.baselineOff.length) return;
  console.warn(
    JSON.stringify({
      level: 'warn',
      event: 'retention.drift_baseline',
      projectId,
      runId,
      measures: verification.baselineOff.map((check) => ({
        table: DRIFT_TABLES[check],
        measure: check,
        drift: verification.baseline[check],
        allowance: verification.allowance[check],
      })),
    }),
  );
}

export type CompletionVerdict = { outcome: 'unverified' } | { outcome: 'verified' | 'drift'; verification: RetentionVerification; grew: Check[] };

/** At completion (the run's DELETEs are done, nothing pending): read the drift again and compare. */
export async function verifyAtCompletion(
  ch: ClickHouseClient,
  run: { projectId: string; cutoff: Date; verification: Prisma.JsonValue | null },
): Promise<CompletionVerdict> {
  const verification = readVerification(run.verification);
  if (!verification) return { outcome: 'unverified' };
  const now = await retentionRollupDrift(ch, run.projectId, run.cutoff);
  const grew = driftGrew(verification, now);
  return {
    outcome: grew.length ? 'drift' : 'verified',
    grew,
    verification: { ...verification, result: { checkedAt: (await databaseClock(prisma)).toISOString(), drift: now, grew } },
  };
}

/** At most one baseline-drift repair per project per day (database clock). */
export async function driftRepairAllowed(projectId: string) {
  const [row] = await prisma.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n FROM "RetentionRun"
    WHERE "projectId" = ${projectId} AND kind = 'ingest_repair' AND error LIKE ${`${DRIFT_REPAIR_ERROR}%`}
      AND "startedAt" > (clock_timestamp() AT TIME ZONE 'UTC') - interval '1 day'`;
  return Number(row?.n ?? 0) === 0;
}

const describe = (checks: Check[], verification: RetentionVerification, now: RollupDrift) =>
  checks.map(
    (check) =>
      `${DRIFT_TABLES[check]} ${check} ${now[check] - verification.baseline[check] >= 0 ? '+' : ''}${now[check] - verification.baseline[check]}`,
  );

/**
 * Checks this project's completed background runs that recorded a baseline and have no result yet. Called right after
 * the completing caller released the project lock (the server's reconciler, and the start of each background run):
 * the reading scans the project, so it never runs inside the lock. A conditional update makes exactly one caller act.
 * - drift grew: the run becomes failed, naming the table(s); the project's repair is queued (the next synchronous run
 *   rebuilds the rollups because the latest run failed);
 * - verified: the result is recorded; a baseline that was already off queues one repair per project per day (a failed
 *   ingest_repair, which fences reads until the queued run rebuilds the rollups).
 * Runs without a baseline (from before the column, or synchronous runs) are not verified and are left as they are.
 */
export async function verifyRetentionRuns(ch: ClickHouseClient, projectId: string, enqueueRepair: (projectId: string) => Promise<unknown>) {
  const runs = await prisma.$queryRaw<{ id: string; projectId: string; cutoff: Date; retentionDays: number; verification: Prisma.JsonValue }[]>`
    SELECT id, "projectId", cutoff, "retentionDays", verification FROM "RetentionRun"
    WHERE "projectId" = ${projectId} AND kind = 'retention' AND status = 'completed'
      AND verification IS NOT NULL AND NOT (verification ? 'result')
    ORDER BY "startedAt" ASC LIMIT 5`;
  for (const run of runs) {
    const verdict = await verifyAtCompletion(ch, run);
    if (verdict.outcome === 'unverified') continue;
    const { verification } = verdict;
    const now = verification.result?.drift as RollupDrift;
    if (verdict.outcome === 'drift') {
      const changes = describe(verdict.grew, verification, now);
      const won = await prisma.$executeRaw`
        UPDATE "RetentionRun" SET status = 'failed', "finishedAt" = clock_timestamp() AT TIME ZONE 'UTC',
          error = ${`Derived tables disagree with the stored events after this run (${tablesOf(verdict.grew).join(', ')}); the project's rollups are being rebuilt.`},
          verification = ${JSON.stringify(verification)}::jsonb
        WHERE id = ${run.id} AND status = 'completed' AND NOT (verification ? 'result')`;
      if (!won) continue;
      console.error(
        JSON.stringify({ level: 'error', event: 'retention.verification_drift', projectId, runId: run.id, tables: tablesOf(verdict.grew), changes }),
      );
      await enqueueRepair(projectId).catch(() =>
        console.error(JSON.stringify({ level: 'error', event: 'retention.repair_enqueue_failed', projectId, runId: run.id })),
      );
      continue;
    }
    const repair = verification.baselineOff.length > 0 && (await driftRepairAllowed(projectId));
    const recorded: RetentionVerification = {
      ...verification,
      result: { ...(verification.result as NonNullable<RetentionVerification['result']>), repairQueued: repair },
    };
    const won = await prisma.$executeRaw`
      UPDATE "RetentionRun" SET verification = ${JSON.stringify(recorded)}::jsonb
      WHERE id = ${run.id} AND status = 'completed' AND NOT (verification ? 'result')`;
    if (!won || !repair) continue;
    const tables = tablesOf(verification.baselineOff);
    await prisma.retentionRun.create({
      data: {
        projectId,
        kind: 'ingest_repair',
        retentionDays: run.retentionDays,
        cutoff: run.cutoff,
        status: 'failed',
        finishedAt: new Date(),
        error: `${DRIFT_REPAIR_ERROR} before run ${run.id} (${tables.join(', ')}); the next retention run rebuilds the rollups.`,
      },
    });
    console.warn(JSON.stringify({ level: 'warn', event: 'retention.drift_repair_queued', projectId, runId: run.id, tables }));
    await enqueueRepair(projectId).catch(() =>
      console.error(JSON.stringify({ level: 'error', event: 'retention.repair_enqueue_failed', projectId, runId: run.id })),
    );
  }
}
