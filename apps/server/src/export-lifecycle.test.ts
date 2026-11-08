import { afterEach, expect, it, vi } from 'vitest';
import { retryExportValidation, startExportHeartbeat } from './export-lifecycle';

afterEach(() => vi.useRealTimers());
it('retries only busy final boundaries, releasing each attempt before waiting', async () => {
  const attempt = vi
    .fn()
    .mockRejectedValueOnce({ code: 'export_project_busy' })
    .mockRejectedValueOnce({ code: 'export_project_busy' })
    .mockResolvedValue(undefined);
  await retryExportValidation(attempt, new AbortController().signal);
  expect(attempt).toHaveBeenCalledTimes(3);
  const failed = vi.fn().mockRejectedValue({ code: 'export_invalidated' });
  await expect(retryExportValidation(failed, new AbortController().signal)).rejects.toMatchObject({ code: 'export_invalidated' });
  expect(failed).toHaveBeenCalledOnce();
});
it('bounds final retries and interrupts the backoff on cancellation', async () => {
  const busy = vi.fn().mockRejectedValue({ code: 'export_project_busy' });
  const started = performance.now();
  await expect(retryExportValidation(busy, new AbortController().signal, 60)).rejects.toMatchObject({ code: 'export_project_busy' });
  expect(performance.now() - started).toBeLessThan(200);
  const abort = new AbortController();
  const waiting = retryExportValidation(async () => {
    abort.abort();
    throw Object.assign(new Error('Project busy'), { code: 'export_project_busy' });
  }, abort.signal);
  await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
});
it('recovers renewal blips while the confirmed lease still has slack', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  const renew = vi.fn().mockRejectedValueOnce(new Error('fictional outage')).mockResolvedValue(60_000);
  const expired = vi.fn();
  const stop = startExportHeartbeat(renew, 60_000, expired);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(renew).toHaveBeenCalledOnce();
  expect(expired).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1000);
  expect(renew).toHaveBeenCalledTimes(2);
  expect(expired).not.toHaveBeenCalled();
  stop();
  await vi.advanceTimersByTimeAsync(120_000);
  expect(expired).not.toHaveBeenCalled();
  expect(renew).toHaveBeenCalledTimes(2);
});
it('stops at the safety margin, even if the renewal itself never settles', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  const expired = vi.fn();
  const stop = startExportHeartbeat(() => new Promise(() => undefined), 60_000, expired);
  await vi.advanceTimersByTimeAsync(49_999);
  expect(expired).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(expired).toHaveBeenCalledOnce();
  stop();
});
it('retries persistent renewal failures until the existing lease reaches its safety margin', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  const expired = vi.fn(),
    renew = vi.fn().mockRejectedValue(new Error('fictional outage'));
  const stop = startExportHeartbeat(renew, 60_000, expired);
  await vi.advanceTimersByTimeAsync(49_999);
  expect(expired).not.toHaveBeenCalled();
  expect(renew.mock.calls.length).toBeGreaterThan(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(expired).toHaveBeenCalledOnce();
  stop();
});
