import { afterEach, expect, it, vi } from 'vitest';
import { createFailedRepairStatus } from './failed-repair-status';

afterEach(() => vi.useRealTimers());

it('bounds a stalled refresh to 250ms and keeps it single-flight across cache periods', async () => {
  vi.useFakeTimers();
  const load = vi.fn(() => new Promise<never>(() => undefined));
  const status = createFailedRepairStatus(load);
  const first = status();
  const peer = status();
  await vi.advanceTimersByTimeAsync(249);
  let settled = false;
  void first.then(() => {
    settled = true;
  });
  await Promise.resolve();
  expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(await first).toEqual({ unavailable: true });
  expect(await peer).toEqual({ unavailable: true });
  await vi.advanceTimersByTimeAsync(60_000);
  expect(await status()).toEqual({ unavailable: true });
  expect(load).toHaveBeenCalledTimes(1);
});

it('returns stale counts on timeout, then publishes a late successful refresh', async () => {
  vi.useFakeTimers();
  const initial: { fencedProjects: number } = { fencedProjects: 2 };
  let finish!: (value: typeof initial) => void;
  const load = vi
    .fn()
    .mockResolvedValueOnce(initial)
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
  const status = createFailedRepairStatus(load);
  expect(await status()).toEqual({ ...initial, stale: false });
  await vi.advanceTimersByTimeAsync(30_000);
  const refresh = status();
  await vi.advanceTimersByTimeAsync(250);
  expect(await refresh).toEqual({ ...initial, stale: true });
  finish({ fencedProjects: 0 });
  await vi.advanceTimersByTimeAsync(0);
  expect(await status()).toEqual({ fencedProjects: 0, stale: false });
});

it('degrades refresh errors without rejecting or issuing a query on every probe', async () => {
  const load = vi.fn().mockRejectedValue(new Error('pool unavailable'));
  const status = createFailedRepairStatus(load);
  expect(await status()).toEqual({ unavailable: true });
  expect(await status()).toEqual({ unavailable: true });
  expect(load).toHaveBeenCalledTimes(1);
});
