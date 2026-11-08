import { randomUUID } from 'node:crypto';
import type { ClickHouseClient } from '@clickhouse/client';

/**
 * Project-tagged maintenance writes.
 *
 * Maintenance (rollup rebuilds, index repair, retention/sample purges) writes ClickHouse with synchronous statements
 * that hold no ingest receipt. If the HTTP call fails or times out, ClickHouse keeps executing the statement: an
 * interrupted `INSERT … SELECT` can still commit after its caller gave up and released the project lock. Every
 * maintenance statement for a project therefore carries `query_id = logbird-maint:<projectId>:<uuid>`, so project
 * deletion can find and stop them (`stopProjectMaintenance`) before it purges.
 */
export const maintenanceQueryPrefix = (projectId: string) => `logbird-maint:${projectId}:`;

const TAGGED_METHODS = new Set(['query', 'command', 'insert', 'exec']);

/** `ch`, with every query/command/insert/exec of this project tagged with a maintenance query id (unless one is set). */
export function projectMaintenance(ch: ClickHouseClient, projectId: string): ClickHouseClient {
  const prefix = maintenanceQueryPrefix(projectId);
  return new Proxy(ch, {
    get(target, property) {
      // Read at call time, so methods patched on the underlying client (tests, fixtures) still apply.
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== 'function') return value;
      if (typeof property === 'string' && TAGGED_METHODS.has(property))
        return (params: { query_id?: string } & Record<string, unknown>) =>
          value.call(target, { ...params, query_id: params?.query_id ?? `${prefix}${randomUUID()}` });
      return value.bind(target);
    },
  });
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
