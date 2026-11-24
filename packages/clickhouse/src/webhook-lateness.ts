import type { ClickHouseClient } from './client';
import { read } from './queries';

/** One past the largest webhook delivery window in hours (3,650 days); migration 011 caps late_hours here. */
export const LATENESS_CAP_HOURS = 87_601;

const chTime = (time: Date) => time.toISOString().replace('T', ' ').slice(0, -1);

/**
 * Late arrivals for webhook delivery windows (#152), from `events_lateness_by_hour`. For each `{ since, windowSeconds }`,
 * the project's events that arrived later than the window after they occurred, counted by arrival hour from the hour
 * that contains `since`, before any endpoint filter or scope. One scan for all windows of a project.
 */
export async function lateEventCounts(
  ch: ClickHouseClient,
  projectId: string,
  windows: readonly { since: Date; windowSeconds: number }[],
): Promise<number[]> {
  if (!windows.length) return [];
  const params: Record<string, string | number> = {
    p: projectId,
    earliest: chTime(new Date(Math.min(...windows.map(({ since }) => +since)))),
  };
  const columns = windows.map(({ since, windowSeconds }, index) => {
    if (!Number.isInteger(windowSeconds / 3600) || windowSeconds < 3600) throw new Error('A delivery window is a whole number of hours');
    params[`s${index}`] = chTime(since);
    params[`k${index}`] = windowSeconds / 3600;
    return `sumIf(events, received_hour >= toStartOfHour({s${index}:DateTime64(3,'UTC')}) AND late_hours > {k${index}:UInt32}) AS c${index}`;
  });
  const [row] = await read<Record<string, string | number>>(
    ch,
    `SELECT ${columns.join(', ')} FROM events_lateness_by_hour
      WHERE project_id = {p:String} AND received_hour >= toStartOfHour({earliest:DateTime64(3,'UTC')})`,
    params,
  );
  return windows.map((_, index) => Number(row?.[`c${index}`] ?? 0));
}
