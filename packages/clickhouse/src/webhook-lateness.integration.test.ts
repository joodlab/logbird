import { randomUUID } from 'node:crypto';
import { afterAll, expect, it } from 'vitest';
import { createMaintenanceClickHouseClient, insertEvents } from './client';
import { normalizeEvent } from './normalize';
import { purgeProject, read } from './queries';
import { lateEventCounts } from './webhook-lateness';

const ch = createMaintenanceClickHouseClient();
const projectId = `qa-lateness-${randomUUID()}`;
const hour = 3_600_000;
afterAll(async () => {
  try {
    await purgeProject(ch, projectId);
  } finally {
    await ch.close();
  }
});

it.runIf(process.env.CLICKHOUSE_URL)(
  'counts late arrivals by whole hours, exactly at the window boundary, and deletes them with the project',
  async () => {
    // Mid-hour, so every event falls in one arrival hour.
    const receivedAt = new Date(Math.floor(Date.now() / hour) * hour + 30 * 60_000);
    const lateness = {
      future: -30 * 60_000,
      onTime: 0,
      halfHour: 30 * 60_000,
      oneHour: hour,
      justOverOneHour: hour + 1,
      twoHours: 2 * hour,
      maximum: 3650 * 24 * hour,
    };
    const rows = Object.entries(lateness).map(([id, late]) => {
      const normalized = normalizeEvent(
        { id, action: 'qa.lateness', occurredAt: new Date(+receivedAt - late).toISOString() },
        { projectId, receivedAt },
      );
      if (!normalized.ok) throw new Error(normalized.reason);
      return normalized.row;
    });
    await insertEvents(ch, rows);
    const buckets = await read<{ late_hours: number; n: string }>(
      ch,
      'SELECT late_hours, sum(events) n FROM events_lateness_by_hour WHERE project_id = {p:String} GROUP BY late_hours ORDER BY late_hours',
      { p: projectId },
    );
    // ceil(lateness / 1 h), floored at 0: an occurrence ahead of arrival is not late.
    expect(buckets.map(({ late_hours, n }) => [Number(late_hours), Number(n)])).toEqual([
      [0, 2],
      [1, 2],
      [2, 2],
      [87_600, 1],
    ]);
    const since = new Date(+receivedAt - hour);
    const counts = await lateEventCounts(ch, projectId, [
      { since, windowSeconds: 3600 },
      { since, windowSeconds: 7200 },
      { since, windowSeconds: 87_599 * 3600 },
      { since, windowSeconds: 87_600 * 3600 },
      { since: new Date(+receivedAt + hour), windowSeconds: 3600 },
    ]);
    // A 1 h window: over one hour late (1 h + 1 ms, 2 h, 3,650 d); exactly one hour is on time. Counting starts at the
    // arrival hour that contains `since`, so a `since` after the arrival hour counts nothing.
    expect(counts).toEqual([3, 1, 1, 0, 0]);
    await purgeProject(ch, projectId);
    expect(await lateEventCounts(ch, projectId, [{ since, windowSeconds: 3600 }])).toEqual([0]);
  },
);
