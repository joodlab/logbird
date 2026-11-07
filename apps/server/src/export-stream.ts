import { createHash } from 'node:crypto';

export type ExportCounts = {
  rows: number;
  bytes: number;
  sha256?: string;
  reason?:
    | 'client_aborted'
    | 'invalid_query'
    | 'audit_unavailable'
    | 'sql_unavailable'
    | 'membership_changed'
    | 'idle_timeout'
    | 'lease_expired'
    | 'resource_limit'
    | 'export_error';
};
export type ExportReceipt = (action: 'export.requested' | 'export.completed' | 'export.failed', counts: ExportCounts) => Promise<unknown>;
const pendingReceipts = new Set<Promise<unknown>>();
export const drainExportAudits = async () => {
  while (pendingReceipts.size) await Promise.allSettled([...pendingReceipts]);
};
function track(promise: Promise<unknown>) {
  pendingReceipts.add(promise);
  void promise.finally(() => pendingReceipts.delete(promise));
  return promise;
}
const failureReason = (error: unknown): NonNullable<ExportCounts['reason']> => {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  if (error && typeof error === 'object' && 'details' in error && (error.details as { reason?: string })?.reason === 'limit') return 'resource_limit';
  if (error instanceof Error && (error.name === 'QueryError' || /^Invalid (time range|query syntax)/.test(error.message))) return 'invalid_query';
  if (code === 'sql_mode_unavailable') return 'sql_unavailable';
  if (code === 'export_invalidated') return 'membership_changed';
  if (code === 'export_lease_expired') return 'lease_expired';
  return 'export_error';
};

/** Counts and digest cover exactly UTF-8 bytes enqueued, not client acknowledgement of a saved file. */
export async function auditedExport(
  source: AsyncGenerator<string, void> | (() => Promise<AsyncGenerator<string, void>>),
  csv: boolean,
  receipt: ExportReceipt,
  signal: AbortSignal,
  exportId?: string,
  lifecycle: {
    idleMs?: number;
    maxDurationMs?: number;
    beforeComplete?: () => Promise<void>;
    onSettled?: (action: 'export.completed' | 'export.failed') => Promise<unknown>;
  } = {},
) {
  let rows = 0,
    bytes = 0,
    header = csv;
  let state: 'streaming' | 'completing' | 'closed' | 'failed' = 'streaming';
  let iterator: AsyncGenerator<string, void> | undefined;
  let completion: Promise<unknown> | undefined, failure: Promise<unknown> | undefined;
  const hash = createHash('sha256');
  let idle: ReturnType<typeof setTimeout> | undefined, deadline: ReturnType<typeof setTimeout> | undefined;
  let settlement: Promise<unknown> | undefined;
  const cleanup = () => {
    clearTimeout(idle);
    clearTimeout(deadline);
    signal.removeEventListener('abort', abort);
    settlement ??= track(
      (lifecycle.onSettled?.(state === 'closed' ? 'export.completed' : 'export.failed') ?? Promise.resolve()).catch(() =>
        console.error(JSON.stringify({ event: 'export.release_failed', exportId })),
      ),
    );
    return settlement;
  };
  const terminalReceipt = (action: 'export.completed' | 'export.failed', counts: ExportCounts) =>
    track(receipt(action, counts).catch(() => console.error(JSON.stringify({ event: 'export.audit_storage_unavailable', exportId, action }))));
  const fail = (reason: NonNullable<ExportCounts['reason']>) => {
    if (state === 'closed') return Promise.resolve();
    state = 'failed';
    // Cancellation can supersede an in-flight completion. Persist the corrective failure after that write.
    failure ??= track(
      (async () => {
        await completion?.catch(() => undefined);
        await terminalReceipt('export.failed', { rows, bytes, reason });
        await cleanup();
      })(),
    );
    return failure;
  };
  // Fail closed: the caller must verify accepted/rejected before any generator is consumed.
  try {
    await receipt('export.requested', { rows, bytes });
  } catch (error) {
    // Staging may succeed even if acknowledgement fails. Independently persist the no-bytes failure when possible.
    await fail('audit_unavailable');
    throw error;
  }
  let first: IteratorResult<string> | undefined;
  try {
    if (signal.aborted) throw new Error('Export aborted');
    iterator = typeof source === 'function' ? await source() : source;
    first = await iterator.next();
  } catch (error) {
    await fail(signal.aborted ? 'client_aborted' : failureReason(error));
    await iterator?.return();
    throw error;
  }
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array>;
  function abort() {
    stop(signal.reason?.code === 'export_lease_expired' ? 'lease_expired' : 'client_aborted', new Error('Export aborted'));
  }
  const stop = (reason: NonNullable<ExportCounts['reason']>, error: Error) => {
    if (state === 'closed') return;
    void fail(reason);
    controller.error(error);
    clearTimeout(idle);
    clearTimeout(deadline);
    signal.removeEventListener('abort', abort);
    void iterator?.return().catch(() => console.error(JSON.stringify({ event: 'export.cleanup_failed', exportId })));
  };
  const touch = () => {
    clearTimeout(idle);
    idle = setTimeout(() => stop('idle_timeout', new Error('Export idle timeout')), lifecycle.idleMs ?? 30_000);
    idle.unref?.();
  };
  return new ReadableStream<Uint8Array>({
    start(out) {
      controller = out;
      signal.addEventListener('abort', abort, { once: true });
      touch();
      deadline = setTimeout(() => stop('lease_expired', new Error('Export duration limit')), lifecycle.maxDurationMs ?? 15 * 60_000);
      deadline.unref?.();
      if (signal.aborted) abort();
    },
    async pull(out) {
      if (state !== 'streaming') return;
      touch();
      try {
        const next = first ?? (await iterator.next());
        first = undefined;
        if (signal.aborted || failure) return;
        if (next.done) {
          await lifecycle.beforeComplete?.();
          if (failure) return;
          state = 'completing';
          completion = terminalReceipt('export.completed', { rows, bytes, sha256: hash.digest('hex') });
          await completion;
          if (failure) {
            await failure;
            return;
          }
          state = 'closed';
          // Close production synchronously before freezing the outcome. While the draft write is in flight,
          // abort remains able to supersede it. After close, the record describes producer completion only.
          out.close();
          await cleanup();
          return;
        }
        const chunk = encoder.encode(next.value);
        out.enqueue(chunk);
        hash.update(chunk);
        bytes += chunk.byteLength;
        if (header) header = false;
        else rows++;
        touch();
      } catch (error) {
        await fail(signal.aborted ? 'client_aborted' : failureReason(error));
        await cleanup();
        out.error(error);
        await iterator?.return();
      }
    },
    async cancel() {
      signal.removeEventListener('abort', abort);
      await fail('client_aborted');
      await iterator?.return();
    },
  });
}
