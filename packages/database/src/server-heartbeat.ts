import { randomUUID } from 'node:crypto';
import { prisma } from './index';

/**
 * Each API server records a heartbeat: its instance id, version and capabilities, every SERVER_HEARTBEAT_INTERVAL_MS.
 *
 * Retention uses background deletes only while every server recently seen declares support. Heartbeat-only servers
 * select the synchronous path until they are replaced. A server from before the heartbeat release is invisible.
 */
export const SERVER_HEARTBEAT_CAPABILITY = 'heartbeat-v1';
export const BACKGROUND_RETENTION_CAPABILITY = 'background-retention-v1';
export const SERVER_CAPABILITIES: readonly string[] = [SERVER_HEARTBEAT_CAPABILITY, BACKGROUND_RETENTION_CAPABILITY];
export const SERVER_HEARTBEAT_INTERVAL_MS = 30_000;
const SERVER_HEARTBEAT_WINDOW_MS = 90_000;
/** Rows not seen for this long are deleted by the next heartbeat of any server. */
export const SERVER_HEARTBEAT_PRUNE_AFTER = '1 day';

type Db = Pick<typeof prisma, '$executeRaw'>;

/** Silence never counts as support. */
export async function serversSupport(capability: string, db: Pick<typeof prisma, '$queryRaw'> = prisma) {
  const [row] = await db.$queryRaw<{ seen: number; missing: number }[]>`
    SELECT count(*)::int AS seen, (count(*) FILTER (WHERE NOT (${capability} = ANY("capabilities"))))::int AS missing
    FROM "ServerHeartbeat"
    WHERE "seenAt" > (clock_timestamp() AT TIME ZONE 'UTC') - make_interval(secs => ${SERVER_HEARTBEAT_WINDOW_MS / 1000})`;
  const seen = row?.seen ?? 0;
  const missing = row?.missing ?? 0;
  return { capable: seen > 0 && missing === 0, seen, missing };
}

/** One upsert, stamped by the database clock (so no instance clock can make a row look fresh or stale). */
export async function recordServerHeartbeat(instanceId: string, version: string, capabilities: readonly string[], db: Db = prisma) {
  await db.$executeRaw`
    INSERT INTO "ServerHeartbeat" ("instanceId", "version", "capabilities", "seenAt")
    VALUES (${instanceId}, ${version}, ${[...capabilities]}::text[], clock_timestamp() AT TIME ZONE 'UTC')
    ON CONFLICT ("instanceId") DO UPDATE
      SET "version" = EXCLUDED."version", "capabilities" = EXCLUDED."capabilities", "seenAt" = EXCLUDED."seenAt"`;
}

/** Deletes rows not seen for SERVER_HEARTBEAT_PRUNE_AFTER (a crashed or removed server). Indexed on `seenAt`. */
export async function pruneServerHeartbeats(db: Db = prisma) {
  return db.$executeRaw`
    DELETE FROM "ServerHeartbeat" WHERE "seenAt" < (clock_timestamp() AT TIME ZONE 'UTC') - ${SERVER_HEARTBEAT_PRUNE_AFTER}::interval`;
}

/**
 * Heartbeats this server now and every SERVER_HEARTBEAT_INTERVAL_MS, pruning stale rows each time. A failed beat is
 * logged and retried at the next interval. `stop` ends the beats and removes this server's row, so a cleanly stopped
 * server disappears at once; a crashed one leaves its row to age out and be pruned.
 */
export function startServerHeartbeat({
  version,
  capabilities = SERVER_CAPABILITIES,
  db = prisma,
  intervalMs = SERVER_HEARTBEAT_INTERVAL_MS,
}: {
  version: string;
  capabilities?: readonly string[];
  db?: Db;
  intervalMs?: number;
}) {
  const instanceId = randomUUID();
  let stopped = false;
  let inFlight: Promise<void> | undefined;
  const beat = () => {
    if (stopped || inFlight) return;
    inFlight = (async () => {
      await recordServerHeartbeat(instanceId, version, capabilities, db);
      await pruneServerHeartbeats(db);
    })()
      .catch(() => console.error(JSON.stringify({ level: 'error', event: 'server.heartbeat_failed' })))
      .finally(() => {
        inFlight = undefined;
      });
  };
  beat();
  const timer = setInterval(beat, intervalMs);
  timer.unref();
  return {
    instanceId,
    async stop() {
      stopped = true;
      clearInterval(timer);
      // A beat still in flight must not re-insert the row after it was removed.
      await inFlight;
      await db.$executeRaw`DELETE FROM "ServerHeartbeat" WHERE "instanceId" = ${instanceId}`.catch(() =>
        console.error(JSON.stringify({ level: 'error', event: 'server.heartbeat_remove_failed' })),
      );
    },
  };
}
