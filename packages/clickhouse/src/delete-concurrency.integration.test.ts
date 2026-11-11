import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { createMaintenanceClickHouseClient, insertEvents } from './client';
import { normalizeEvent } from './normalize';
import { purgeProject, read } from './queries';

const tables = ['events', 'event_ids', 'events_by_minute', 'entities', 'attribute_keys'];

it.runIf(process.env.CLICKHOUSE_URL)(
  'concurrent project purges leave no raw, identity or rollup rows',
  async () => {
    const ch = createMaintenanceClickHouseClient();
    const projects = Array.from({ length: 2 }, () => `qa95-${randomUUID()}`);
    console.info(JSON.stringify({ event: 'qa95.concurrent_delete_fixtures', projects }));
    const warn = vi.spyOn(console, 'warn');
    let needsCleanup = false;
    try {
      for (let round = 0; round < 2; round++) {
        const receivedAt = new Date();
        const rows = projects.map((projectId) => {
          const normalized = normalizeEvent(
            {
              id: `round-${round}`,
              action: 'qa95.concurrent-delete',
              actor: { id: 'qa95-actor', type: 'user' },
              tenant: { id: 'qa95-tenant' },
              executor: { id: 'qa95-worker', type: 'worker' },
              targets: [{ type: 'fixture', id: 'qa95-target' }],
              metadata: { fixture: 'qa95' },
            },
            { projectId, receivedAt },
          );
          if (!normalized.ok) throw new Error(normalized.reason);
          return normalized.row;
        });
        // One insert puts every project into the same parts, with all MVs populated.
        needsCleanup = true;
        await insertEvents(ch, rows);
        for (const table of tables) {
          const counts = await read<{ project_id: string; n: number }>(
            ch,
            `SELECT project_id,count() n FROM ${table} WHERE project_id IN {projects:Array(String)} GROUP BY project_id`,
            { projects },
          );
          expect(counts).toHaveLength(projects.length);
          expect(counts.every((row) => Number(row.n) > 0)).toBe(true);
        }
        // Wait for every purge to settle before assertions or cleanup, even on failure.
        const purges = await Promise.allSettled(projects.map((project) => purgeProject(ch, project)));
        for (const result of purges) if (result.status === 'rejected') throw result.reason;
        for (const table of tables) {
          const counts = await read<{ n: number }>(ch, `SELECT count() n FROM ${table} WHERE project_id IN {projects:Array(String)}`, { projects });
          expect(Number(counts[0]?.n), table).toBe(0);
        }
        needsCleanup = false;
      }
    } finally {
      const retries = warn.mock.calls.filter(([message]) => {
        if (typeof message !== 'string' || !message.startsWith('{')) return false;
        try {
          const entry = JSON.parse(message);
          return entry.event === 'clickhouse.delete_retry' && projects.includes(entry.projectId);
        } catch {
          return false;
        }
      }).length;
      warn.mockRestore();
      console.info(JSON.stringify({ event: 'qa95.concurrent_delete_result', projects: projects.length, rounds: 2, retries }));
      try {
        // Serial cleanup keeps the shared mutation pool quiet; only our exact ids. A cleanup error is logged, not
        // thrown, so it cannot replace the assertion that failed the test.
        if (needsCleanup) for (const project of projects) await purgeProject(ch, project);
      } catch (error) {
        console.error(JSON.stringify({ event: 'qa95.cleanup_failed', projects, error: String(error) }));
      } finally {
        await ch.close();
      }
    }
  },
  240_000,
);
