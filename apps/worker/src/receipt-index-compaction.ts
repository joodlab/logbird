import { compactIngestReceiptIndex } from '@logbird/database';
import type Redis from 'ioredis';

const BACKOFF_SECONDS = 24 * 60 * 60;

/** BullMQ's shared connection retries indefinitely, so optional hints need their own deadline. */
async function backoffHint<T>(operation: Promise<T>, signal: AbortSignal, command: 'get' | 'set'): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  const interrupted = new Promise<undefined>((resolve) => {
    abort = () => resolve(undefined);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    timer = setTimeout(() => {
      console.warn(JSON.stringify({ level: 'warn', event: 'ingest.receipt_index_backoff_timeout', command }));
      resolve(undefined);
    }, 1000);
  });
  try {
    return await Promise.race([operation.catch(() => undefined), interrupted]);
  } finally {
    clearTimeout(timer);
    if (abort) signal.removeEventListener('abort', abort);
  }
}

/** Best effort, one attempt per hourly job; independent of recovery and fence lifting. */
export async function runReceiptIndexCompaction(redis: Pick<Redis, 'get' | 'set'>, backoffKey: string, attemptsMade: number, signal: AbortSignal) {
  if (attemptsMade > 0 || signal.aborted) return;
  try {
    // Redis is only a backoff hint: an outage must not disable maintenance.
    const backedOff = await backoffHint(redis.get(backoffKey), signal, 'get');
    if (signal.aborted) return;
    // While backed off, still drop an invalid copy a failed rebuild left behind (every receipt write maintains it).
    const result = await compactIngestReceiptIndex({ signal, cleanupOnly: Boolean(backedOff) });
    // An invalid copy this role cannot drop needs the table owner; warn once per back-off window, not hourly.
    if (result.action === 'skipped_invalid_copy') await backoffHint(redis.set(backoffKey, String(Date.now()), 'EX', BACKOFF_SECONDS), signal, 'set');
    if (result.action !== 'skipped_compact') {
      const level = result.action === 'reindexed' || result.action === 'skipped_backoff' ? 'info' : 'warn';
      console[level === 'warn' ? 'warn' : 'log'](JSON.stringify({ level, event: 'ingest.receipt_index_compaction', ...result }));
    }
    return result;
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined;
    if (signal.aborted) {
      // Shutdown cancelled the run on purpose; the next run drops any invalid copy left behind.
      console.info(JSON.stringify({ level: 'info', event: 'ingest.receipt_index_compaction_aborted' }));
      return;
    }
    if (code === '57014' || code === '55P03') await backoffHint(redis.set(backoffKey, String(Date.now()), 'EX', BACKOFF_SECONDS), signal, 'set');
    console.error(JSON.stringify({ level: 'error', event: 'ingest.receipt_index_compaction_failed', code }));
  }
}
