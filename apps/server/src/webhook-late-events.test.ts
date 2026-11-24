import { WEBHOOK_LOG_RETENTION_MS } from '@logbird/database/webhooks';
import { expect, it, vi } from 'vitest';
import { type LateInput, lateEvents } from './webhook-late-events';

const now = new Date('2026-11-24T12:00:00.000Z');
const endpoint = (id: string, projectId: string, deliveryWindowSeconds: number | null, changedHoursAgo = 1): LateInput => ({
  id,
  projectId,
  deliveryWindowSeconds,
  deliveryWindowChangedAt: new Date(+now - changedHoursAgo * 3_600_000),
});

it("counts each project's windows against that project only and gives a null window 0", async () => {
  const count = vi.fn(async (projectId: string, windows: { windowSeconds: number }[]) =>
    windows.map(({ windowSeconds }) => (projectId === 'project-a' ? windowSeconds : -windowSeconds)),
  );
  const late = await lateEvents(
    [endpoint('a1', 'project-a', 3600), endpoint('b1', 'project-b', 7200), endpoint('a2', 'project-a', null), endpoint('a3', 'project-a', 10_800)],
    now,
    count,
  );
  expect(count.mock.calls.map(([projectId, windows]) => [projectId, windows.map(({ windowSeconds }) => windowSeconds)])).toEqual([
    ['project-a', [3600, 10_800]],
    ['project-b', [7200]],
  ]);
  expect(Object.fromEntries([...late].map(([id, { count: n }]) => [id, n]))).toEqual({ a1: 3600, b1: -7200, a2: 0, a3: 10_800 });
});

it('counts from the later of the last window change and 30 days ago, and skips the query without windows', async () => {
  const count = vi.fn(async (_projectId: string, windows: unknown[]) => windows.map(() => 0));
  const late = await lateEvents([endpoint('recent', 'p', 3600, 2), endpoint('old', 'p', 3600, 24 * 90)], now, count);
  expect(late.get('recent')?.since).toEqual(new Date(+now - 2 * 3_600_000));
  // A change at 11:20 counts from the next whole arrival hour, 12:00.
  const midHour = await lateEvents([endpoint('mid', 'p', 3600, 40 / 60)], now, count);
  expect(midHour.get('mid')?.since).toEqual(new Date('2026-11-24T12:00:00.000Z'));
  expect(late.get('old')?.since).toEqual(new Date(+now - WEBHOOK_LOG_RETENTION_MS));
  const none = vi.fn(async () => []);
  expect([...(await lateEvents([endpoint('off', 'p', null)], now, none)).values()]).toEqual([{ count: 0, since: new Date(+now - 3_600_000) }]);
  expect(none).not.toHaveBeenCalled();
});
