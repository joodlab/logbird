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
  'counts late arrivals by whole hours, agrees with discovery at every window boundary, and deletes them with the project',
  async () => {
    // Mid-hour, so every event falls in one arrival hour.
    const receivedAt = new Date(Math.floor(Date.now() / hour) * hour + 30 * 60_000);
    const lateness: Record<string, number> = {
      future: -30 * 60_000,
      onTime: 0,
      halfHour: 30 * 60_000,
      exactlyOneHour: hour,
      oneHourOneSecond: hour + 1000,
      oneHourOneMs: hour + 1,
      exactlyTwoHours: 2 * hour,
      twoHoursOneMs: 2 * hour + 1,
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
    // Ingest refuses occurrence times more than 3,650 days old; a stored row older than that (written before the check)
    // lands in the capped bucket, which every window still counts.
    const ancient = normalizeEvent({ id: 'beyondMaximum', action: 'qa.lateness' }, { projectId, receivedAt });
    if (!ancient.ok) throw new Error(ancient.reason);
    await insertEvents(ch, [...rows, { ...ancient.row, timestamp: new Date(+receivedAt - 3700 * 24 * hour).toISOString() }]);
    const buckets = await read<{ late_hours: number; n: string }>(
      ch,
      'SELECT late_hours, sum(events) n FROM events_lateness_by_hour WHERE project_id = {p:String} GROUP BY late_hours ORDER BY late_hours',
      { p: projectId },
    );
    // Only events more than one hour late reach the rollup; late_hours = ceil(lateness / 1 h).
    expect(buckets.map(({ late_hours, n }) => [Number(late_hours), Number(n)])).toEqual([
      [2, 3],
      [3, 1],
      [87_600, 1],
      [87_601, 1],
    ]);
    // The arrival hour starts at or after `since`, so it counts.
    const since = new Date(+receivedAt - hour);
    const windowsInHours = [1, 2, 3, 87_599, 87_600];
    const counts = await lateEventCounts(
      ch,
      projectId,
      windowsInHours.map((hours) => ({ since, windowSeconds: hours * 3600 })),
    );
    // Discovery delivers an event when lateness <= window (inclusive); the count is exactly the events it skips.
    // The capped row is beyond every window, so it adds one to each.
    const skippedByDiscovery = windowsInHours.map((hours) => Object.values(lateness).filter((late) => late > hours * hour).length + 1);
    expect(counts).toEqual(skippedByDiscovery);
    expect(counts).toEqual([6, 3, 2, 2, 1]);
    // Only whole arrival hours that start at or after `since` count: a `since` inside the arrival hour (here, the moment of
    // arrival) or after it counts nothing.
    expect(await lateEventCounts(ch, projectId, [{ since: receivedAt, windowSeconds: 3600 }])).toEqual([0]);
    expect(await lateEventCounts(ch, projectId, [{ since: new Date(+receivedAt + hour), windowSeconds: 3600 }])).toEqual([0]);
    await purgeProject(ch, projectId);
    expect(await lateEventCounts(ch, projectId, [{ since, windowSeconds: 3600 }])).toEqual([0]);
  },
);
