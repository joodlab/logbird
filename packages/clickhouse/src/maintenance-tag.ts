import { randomUUID } from 'node:crypto';
import type { ClickHouseClient } from '@clickhouse/client';

/**
 * Project-tagged maintenance writes.
 *
 * Maintenance (rollup rebuilds, index repair, retention/sample purges, ingest recovery) writes ClickHouse with
 * synchronous statements that hold no ingest receipt. If the HTTP call fails or times out, ClickHouse keeps executing
 * the statement: an interrupted `INSERT … SELECT` can still commit after its caller gave up and released the project
 * lock. Every maintenance statement for a project therefore carries `query_id = logbird-maint:<project>:<suffix>`,
 * so project deletion can find and stop them (`stopProjectMaintenance`) before it purges.
 *
 * Tagging is enforced inside the shared helpers (`purgeProject`, `rebuildProjectRollups`, `repairEventIndex`, and the
 * worker's recovery/rebuild), so every caller — server, worker, operator scripts — inherits it.
 *
 * `<project>` is the project id in base64url: its alphabet has no `:`, so one project's prefix can never be a prefix
 * of another's (`p1` vs `p1:child`).
 */
export const maintenanceQueryPrefix = (projectId: string) => `logbird-maint:${Buffer.from(projectId, 'utf8').toString('base64url')}:`;

const TAGGED_METHODS = new Set(['query', 'command', 'insert', 'exec']);
/** Tagged clients and the project they tag, so wrapping again is a no-op (helpers re-wrap what callers pass). */
const taggedFor = new WeakMap<object, string>();

/**
 * `ch`, with every query/command/insert/exec of this project carrying the project's maintenance query id. A caller's
 * own `query_id` is kept but prefixed, so it can never escape the tag. Idempotent for the same project.
 */
export function projectMaintenance(ch: ClickHouseClient, projectId: string): ClickHouseClient {
  if (taggedFor.get(ch) === projectId) return ch;
  const prefix = maintenanceQueryPrefix(projectId);
  const tagged = new Proxy(ch, {
    get(target, property) {
      // Read at call time, so methods patched on the underlying client (tests, fixtures) still apply.
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== 'function') return value;
      if (typeof property === 'string' && TAGGED_METHODS.has(property))
        return (params: { query_id?: string } & Record<string, unknown>) => {
          const own = params?.query_id;
          const queryId = own?.startsWith(prefix) ? own : `${prefix}${own ?? randomUUID()}`;
          return value.call(target, { ...params, query_id: queryId });
        };
      return value.bind(target);
    },
  });
  taggedFor.set(tagged, projectId);
  return tagged;
}

const literal = (value: string) => `'${value.replace(/[\\']/g, '\\$&')}'`;

async function runningMaintenance(ch: ClickHouseClient, prefix: string) {
  const rows = await (
    await ch.query({
      query: 'SELECT query_id FROM system.processes WHERE startsWith(query_id, {prefix:String})',
      query_params: { prefix },
      format: 'JSONEachRow',
    })
  ).json<{ query_id: string }>();
  return rows.map((r) => r.query_id);
}

/**
 * Stops every tagged maintenance statement of `projectId` that ClickHouse is still executing (`KILL QUERY … SYNC`)
 * and verifies none is left. Throws when one cannot be confirmed stopped; the caller must then not purge. Callers hold
 * the exclusive project lock, so no new maintenance for the project can start meanwhile. Returns how many were stopped.
 *
 * Single node only: `system.processes` and `KILL QUERY` see the node this client talks to. A multi-replica ClickHouse
 * (a cluster, or replicas behind a load balancer) is not covered; the supported topology is one node.
 */
export async function stopProjectMaintenance(ch: ClickHouseClient, projectId: string, timeoutMs = 30_000): Promise<number> {
  const prefix = maintenanceQueryPrefix(projectId);
  const running = await runningMaintenance(ch, prefix);
  if (!running.length) return 0;
  await ch.command({
    query: `KILL QUERY WHERE query_id IN (${running.map(literal).join(', ')}) SYNC`,
    abort_signal: AbortSignal.timeout(timeoutMs),
  });
  const left = await runningMaintenance(ch, prefix);
  if (left.length)
    throw Object.assign(new Error(`Maintenance for project ${projectId} is still running (${left.length}).`), {
      code: 'LOGBIRD_MAINTENANCE_RUNNING',
    });
  return running.length;
}
