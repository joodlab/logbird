import { randomUUID } from 'node:crypto';
import { prisma } from './index';

/**
 * Each API server records a heartbeat: its instance id, version and capabilities, every SERVER_HEARTBEAT_INTERVAL_MS.
 *
 * Nothing reads it in 0.3. It ships ahead of the release that runs retention without the ingest lock (#296), which
 * uses it only while every server seen recently declares that capability. Because every 0.3 server heartbeats, an
 * upgrade from 0.3 or later shows every server to that release: a 0.3 server appears without the capability, and the
 * worker keeps the synchronous method until the last one is gone.
 */
export const SERVER_HEARTBEAT_CAPABILITY = 'heartbeat-v1';
export const SERVER_CAPABILITIES: readonly string[] = [SERVER_HEARTBEAT_CAPABILITY];
export const SERVER_HEARTBEAT_INTERVAL_MS = 30_000;
/** Rows not seen for this long are deleted by the next heartbeat of any server. */
export const SERVER_HEARTBEAT_PRUNE_AFTER = '1 day';

type Db = Pick<typeof prisma, '$executeRaw'>;

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
  let inFlight: Promise<unknown> = Promise.resolve();
  const beat = () => {
    if (stopped) return;
    inFlight = (async () => {
      await recordServerHeartbeat(instanceId, version, capabilities, db);
      await pruneServerHeartbeats(db);
    })().catch(() => console.error(JSON.stringify({ level: 'error', event: 'server.heartbeat_failed' })));
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
