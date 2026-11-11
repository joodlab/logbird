import { compactIngestReceiptIndex } from '@logbird/database';
import type Redis from 'ioredis';

const BACKOFF_SECONDS = 24 * 60 * 60;

/** Best effort, one attempt per hourly job; independent of recovery and fence lifting. */
export async function runReceiptIndexCompaction(redis: Pick<Redis, 'get' | 'set'>, backoffKey: string, attemptsMade: number, signal: AbortSignal) {
  if (attemptsMade > 0 || signal.aborted) return;
  try {
    // Redis is only a backoff hint: an outage must not disable maintenance.
    const backedOff = await redis.get(backoffKey).catch(() => null);
    if (signal.aborted) return;
    const result = backedOff ? { action: 'skipped_backoff' as const } : await compactIngestReceiptIndex({ signal });
    if (result.action !== 'skipped_compact')
      console.log(JSON.stringify({ level: result.action === 'reindexed' ? 'info' : 'warn', event: 'ingest.receipt_index_compaction', ...result }));
    return result;
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined;
    if (!signal.aborted && (code === '57014' || code === '55P03'))
      await redis.set(backoffKey, String(Date.now()), 'EX', BACKOFF_SECONDS).catch(() => undefined);
    console.error(JSON.stringify({ level: 'error', event: 'ingest.receipt_index_compaction_failed', code }));
  }
}
