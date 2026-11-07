import { createHash } from 'node:crypto';

export type ExportCounts = {
  rows: number;
  bytes: number;
  sha256?: string;
  reason?: 'client_aborted' | 'invalid_query' | 'storage_unavailable' | 'export_error';
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
  if (error instanceof Error && (error.name === 'QueryError' || /^Invalid (time range|query syntax)/.test(error.message))) return 'invalid_query';
  return code === 'sql_mode_unavailable' ? 'storage_unavailable' : 'export_error';
};

/** Counts and digest cover exactly UTF-8 bytes enqueued, not client acknowledgement of a saved file. */
export async function auditedExport(
  source: AsyncGenerator<string, void> | (() => Promise<AsyncGenerator<string, void>>),
  csv: boolean,
  receipt: ExportReceipt,
  signal: AbortSignal,
) {
  let rows = 0,
    bytes = 0,
    header = csv;
  let state: 'streaming' | 'completing' | 'closed' | 'failed' = 'streaming';
  let iterator: AsyncGenerator<string, void> | undefined;
  let completion: Promise<unknown> | undefined, failure: Promise<unknown> | undefined;
  const hash = createHash('sha256');
  const terminalReceipt = (action: 'export.completed' | 'export.failed', counts: ExportCounts) =>
    track(receipt(action, counts).catch(() => console.error(JSON.stringify({ event: 'export.audit_storage_unavailable', action }))));
  const fail = (reason: NonNullable<ExportCounts['reason']>) => {
    if (state === 'closed') return Promise.resolve();
    state = 'failed';
    // Cancellation can supersede an in-flight completion. Persist the corrective failure after that write.
    failure ??= track(
      (async () => {
        await completion;
        await terminalReceipt('export.failed', { rows, bytes, reason });
      })(),
    );
    return failure;
  };
  // Fail closed: the caller must verify accepted/rejected before any generator is consumed.
  await receipt('export.requested', { rows, bytes });
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
  const abort = () => {
    if (state === 'closed') return;
    void fail('client_aborted');
    controller.error(new Error('Export aborted'));
    void iterator?.return().catch(() => console.error('export.cleanup_failed'));
  };
  return new ReadableStream<Uint8Array>({
    start(out) {
      controller = out;
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    },
    async pull(out) {
      if (state !== 'streaming') return;
      try {
        const next = first ?? (await iterator.next());
        first = undefined;
        if (signal.aborted || failure) return;
        if (next.done) {
          state = 'completing';
          completion = terminalReceipt('export.completed', { rows, bytes, sha256: hash.digest('hex') });
          await completion;
          if (failure) {
            await failure;
            return;
          }
          state = 'closed';
          signal.removeEventListener('abort', abort);
          out.close();
          return;
        }
        const chunk = encoder.encode(next.value);
        out.enqueue(chunk);
        hash.update(chunk);
        bytes += chunk.byteLength;
        if (header) header = false;
        else rows++;
      } catch (error) {
        await fail(signal.aborted ? 'client_aborted' : failureReason(error));
        signal.removeEventListener('abort', abort);
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
