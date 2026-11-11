import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const compact = vi.hoisted(() => vi.fn());
vi.mock('@logbird/database', () => ({ compactIngestReceiptIndex: compact }));

import { runReceiptIndexCompaction } from './receipt-index-compaction';

const redis = { get: vi.fn(), set: vi.fn() };
const key = 'qa:ingest-receipt-index-compaction:backoff';
let abort: AbortController;
beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  abort = new AbortController();
  redis.get.mockResolvedValue(null);
  redis.set.mockResolvedValue('OK');
  compact.mockResolvedValue({ action: 'skipped_compact' });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it('runs once on the first attempt and never on job retries', async () => {
  await runReceiptIndexCompaction(redis, key, 0, abort.signal);
  await runReceiptIndexCompaction(redis, key, 1, abort.signal);
  await runReceiptIndexCompaction(redis, key, 2, abort.signal);
  expect(compact).toHaveBeenCalledExactlyOnceWith({ signal: abort.signal });
  expect(redis.get).toHaveBeenCalledTimes(1);
});

it.each(['57014', '55P03'])('persists a 24 h backoff timestamp on %s, then skips the next run', async (code) => {
  compact.mockRejectedValueOnce(Object.assign(new Error('private SQL'), { code }));
  const started = Date.now();
  await expect(runReceiptIndexCompaction(redis, key, 0, abort.signal)).resolves.toBeUndefined();
  expect(redis.set).toHaveBeenCalledWith(key, expect.any(String), 'EX', 86_400);
  const timestamp = redis.set.mock.calls[0]?.[1];
  expect(Number(timestamp)).toBeGreaterThanOrEqual(started);
  expect(Number(timestamp)).toBeLessThanOrEqual(Date.now());
  redis.get.mockResolvedValueOnce(timestamp);
  await expect(runReceiptIndexCompaction(redis, key, 0, abort.signal)).resolves.toEqual({ action: 'skipped_backoff' });
  expect(compact).toHaveBeenCalledTimes(1);
  expect(console.error).toHaveBeenCalledWith(JSON.stringify({ level: 'error', event: 'ingest.receipt_index_compaction_failed', code }));
  // A back-off skip is expected for 24 hours: informational, not a warning every hour.
  expect(console.log).toHaveBeenCalledWith(JSON.stringify({ level: 'info', event: 'ingest.receipt_index_compaction', action: 'skipped_backoff' }));
});

it('backs off for 24 h after an invalid copy this role cannot drop, warning once', async () => {
  compact.mockResolvedValueOnce({ action: 'skipped_invalid_copy', indexPages: 81_920, droppedInvalid: 0 });
  await runReceiptIndexCompaction(redis, key, 0, abort.signal);
  expect(redis.set).toHaveBeenCalledWith(key, expect.any(String), 'EX', 86_400);
  expect(console.warn).toHaveBeenCalledWith(
    JSON.stringify({
      level: 'warn',
      event: 'ingest.receipt_index_compaction',
      action: 'skipped_invalid_copy',
      indexPages: 81_920,
      droppedInvalid: 0,
    }),
  );
});

it('fails open on Redis read and write errors and never throws a compaction failure', async () => {
  redis.get.mockRejectedValue(new Error('redis unavailable'));
  await runReceiptIndexCompaction(redis, key, 0, abort.signal);
  compact.mockRejectedValueOnce({ code: '57014' });
  redis.set.mockRejectedValueOnce(new Error('redis unavailable'));
  await expect(runReceiptIndexCompaction(redis, key, 0, abort.signal)).resolves.toBeUndefined();
  expect(compact).toHaveBeenCalledTimes(2);
});

it('logs other failures without backing off or throwing', async () => {
  compact.mockRejectedValueOnce({ code: '42501' });
  await expect(runReceiptIndexCompaction(redis, key, 0, abort.signal)).resolves.toBeUndefined();
  expect(redis.set).not.toHaveBeenCalled();
  expect(console.error).toHaveBeenCalledWith(JSON.stringify({ level: 'error', event: 'ingest.receipt_index_compaction_failed', code: '42501' }));
});

it.each(['skipped_missing', 'skipped_no_statistics', 'skipped_old_transactions', 'reindexed'])(
  'logs %s with the appropriate level',
  async (action) => {
    compact.mockResolvedValueOnce({ action, indexPages: 10, droppedInvalid: 0 });
    await runReceiptIndexCompaction(redis, key, 0, abort.signal);
    // A log router keyed on the stream sees warn-level outcomes as warnings.
    expect(action === 'reindexed' ? console.log : console.warn).toHaveBeenCalledWith(
      JSON.stringify({
        level: action === 'reindexed' ? 'info' : 'warn',
        event: 'ingest.receipt_index_compaction',
        action,
        indexPages: 10,
        droppedInvalid: 0,
      }),
    );
  },
);

it('does not start compaction after shutdown', async () => {
  abort.abort();
  await runReceiptIndexCompaction(redis, key, 0, abort.signal);
  expect(compact).not.toHaveBeenCalled();
  expect(redis.get).not.toHaveBeenCalled();
});

it('does not start a connection if shutdown happens while checking backoff', async () => {
  redis.get.mockImplementationOnce(async () => {
    abort.abort();
    return null;
  });
  await runReceiptIndexCompaction(redis, key, 0, abort.signal);
  expect(compact).not.toHaveBeenCalled();
});

it.each(['get', 'set'] as const)('bounds a never-resolving Redis %s to one second', async (command) => {
  vi.useFakeTimers();
  redis[command].mockReturnValueOnce(new Promise(() => undefined));
  if (command === 'set') compact.mockRejectedValueOnce({ code: '57014' });
  const running = runReceiptIndexCompaction(redis, key, 0, abort.signal);
  await vi.advanceTimersByTimeAsync(999);
  if (command === 'get') expect(compact).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await running;
  expect(compact).toHaveBeenCalledTimes(1);
  expect(console.warn).toHaveBeenCalledWith(JSON.stringify({ level: 'warn', event: 'ingest.receipt_index_backoff_timeout', command }));
  expect(vi.getTimerCount()).toBe(0);
});

it.each(['get', 'set'] as const)('returns promptly when shutdown interrupts a never-resolving Redis %s', async (command) => {
  vi.useFakeTimers();
  redis[command].mockReturnValueOnce(new Promise(() => undefined));
  if (command === 'set') compact.mockRejectedValueOnce({ code: '57014' });
  const running = runReceiptIndexCompaction(redis, key, 0, abort.signal);
  await vi.advanceTimersByTimeAsync(0);
  expect(redis[command]).toHaveBeenCalledTimes(1);
  abort.abort();
  await running;
  expect(compact).toHaveBeenCalledTimes(command === 'get' ? 0 : 1);
  expect(vi.getTimerCount()).toBe(0);
});

it('never writes a 24 h backoff for an aborted rebuild', async () => {
  compact.mockImplementationOnce(async () => {
    abort.abort();
    throw Object.assign(new Error('qa cancellation'), { code: '57014' });
  });
  await runReceiptIndexCompaction(redis, key, 0, abort.signal);
  expect(redis.set).not.toHaveBeenCalled();
  // A shutdown is not a failure: no error-level log, an info-level abort instead.
  expect(console.error).not.toHaveBeenCalledWith(expect.stringContaining('ingest.receipt_index_compaction_failed'));
  expect(console.info).toHaveBeenCalledWith(JSON.stringify({ level: 'info', event: 'ingest.receipt_index_compaction_aborted' }));
});
