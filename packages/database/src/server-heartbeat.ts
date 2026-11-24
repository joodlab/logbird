import { randomUUID } from 'node:crypto';
import { prisma } from './index';

/**
 * What an API server supports, declared in its heartbeat (#296). The worker runs background retention (two short
 * fences, staged rollups, DELETE mutations that readers apply on the fly) only while every server seen recently
 * declares `background-retention-v1`: a server without it reads and ingests as if retention held the lock throughout,
 * and would count rows a background run is replacing.
 *
 * Remove the gate, this capability and the synchronous fallback it selects in the release after every supported
 * upgrade path passes through a version that heartbeats (see the PR and CHANGELOG for the release named).
 */
export const BACKGROUND_RETENTION_CAPABILITY = 'background-retention-v1';
export const SERVER_CAPABILITIES = [BACKGROUND_RETENTION_CAPABILITY] as const;
export const SERVER_HEARTBEAT_INTERVAL_MS = 30_000;
/** A server not seen for this long no longer counts: it stopped, or rolled back to a version that does not heartbeat. */
export const SERVER_HEARTBEAT_WINDOW_MS = 90_000;
const PRUNE_AFTER = '1 day';

type Db = Pick<typeof prisma, '$executeRaw' | '$queryRaw'>;

/** One cheap upsert stamped by the database clock, then a pruning delete of rows not seen for a day (indexed). */
export async function recordServerHeartbeat(instanceId: string, capabilities: readonly string[], db: Db = prisma) {
  await db.$executeRaw`
    INSERT INTO "ServerHeartbeat" ("instanceId", "capabilities", "seenAt")
    VALUES (${instanceId}, ${[...capabilities]}::text[], clock_timestamp() AT TIME ZONE 'UTC')
    ON CONFLICT ("instanceId") DO UPDATE SET "capabilities" = EXCLUDED."capabilities", "seenAt" = EXCLUDED."seenAt"`;
  await db.$executeRaw`DELETE FROM "ServerHeartbeat" WHERE "seenAt" < (clock_timestamp() AT TIME ZONE 'UTC') - ${PRUNE_AFTER}::interval`;
}

/**
 * Whether every API server seen in the last SERVER_HEARTBEAT_WINDOW_MS declares `capability`. A window with no server
 * seen counts as not capable: an older server does not heartbeat at all, so silence never means support.
 */
export async function serversSupport(capability: string, db: Db = prisma) {
  const [row] = await db.$queryRaw<{ seen: number; missing: number }[]>`
    SELECT count(*)::int AS seen, (count(*) FILTER (WHERE NOT (${capability} = ANY("capabilities"))))::int AS missing
    FROM "ServerHeartbeat"
    WHERE "seenAt" > (clock_timestamp() AT TIME ZONE 'UTC') - make_interval(secs => ${SERVER_HEARTBEAT_WINDOW_MS / 1000})`;
  const seen = Number(row?.seen ?? 0),
    missing = Number(row?.missing ?? 0);
  return { capable: seen > 0 && missing === 0, seen, missing };
}

/**
 * Heartbeats this server every SERVER_HEARTBEAT_INTERVAL_MS, starting now. A failed beat is logged and retried at the
 * next interval (the worker then sees the row age out, which only selects the synchronous path). `stop` removes this
 * server's row, so a stopped server stops counting at once.
 */
export function startServerHeartbeat(capabilities: readonly string[] = SERVER_CAPABILITIES, db: Db = prisma) {
  const instanceId = randomUUID();
  const beat = () =>
    recordServerHeartbeat(instanceId, capabilities, db).catch(() =>
      console.error(JSON.stringify({ level: 'error', event: 'server.heartbeat_failed' })),
    );
  void beat();
  const timer = setInterval(beat, SERVER_HEARTBEAT_INTERVAL_MS);
  timer.unref();
  return {
    instanceId,
    async stop() {
      clearInterval(timer);
      await db.$executeRaw`DELETE FROM "ServerHeartbeat" WHERE "instanceId" = ${instanceId}`.catch(() => undefined);
    },
  };
}
