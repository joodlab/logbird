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
    | 'project_unreadable'
    | 'storage_unavailable'
    | 'project_busy'
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
  if (code === 'export_project_unreadable') return 'project_unreadable';
  if (code === 'export_storage_unavailable') return 'storage_unavailable';
  if (code === 'export_project_busy') return 'project_busy';
  if (code === 'export_lease_expired') return 'lease_expired';
  return 'export_error';
};

/** Counts and digest cover exactly UTF-8 bytes enqueued, not client acknowledgement of a saved file. */
export async function auditedExport(
  source: AsyncGenerator<string, void> | ((signal: AbortSignal) => Promise<AsyncGenerator<string, void>>),
  csv: boolean,
  receipt: ExportReceipt,
  signal: AbortSignal,
  exportId?: string,
  lifecycle: {
    idleMs?: number;
    maxDurationMs?: number;
    beforeComplete?: (signal: AbortSignal) => Promise<void>;
    onTerminal?: (action: 'export.completed' | 'export.failed') => Promise<unknown>;
    onSettled?: (action: 'export.completed' | 'export.failed') => Promise<unknown>;
  } = {},
) {
  let rows = 0,
    bytes = 0,
    header = csv;
  let state: 'streaming' | 'completing' | 'closed' | 'failed' = 'streaming';
  let iterator: AsyncGenerator<string, void> | undefined;
  let opening: Promise<AsyncGenerator<string, void>> | undefined;
  let reading: Promise<IteratorResult<string, void>> | undefined;
  let completion: Promise<unknown> | undefined, failure: Promise<unknown> | undefined, settlement: Promise<unknown> | undefined;
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const producer = new AbortController();
  const hash = createHash('sha256');
  let idle: ReturnType<typeof setTimeout> | undefined, deadline: ReturnType<typeof setTimeout> | undefined;
  const stopTimers = () => {
    clearTimeout(idle);
    clearTimeout(deadline);
    signal.removeEventListener('abort', abort);
  };
  const cleanup = () => {
    settlement ??= track(
      (async () => {
        stopTimers();
        await Promise.allSettled([opening, reading]);
        try {
          await iterator?.return();
        } catch {
          console.error(JSON.stringify({ event: 'export.cleanup_failed', exportId }));
        }
        await lifecycle.onSettled?.(state === 'closed' ? 'export.completed' : 'export.failed');
      })().catch(() => console.error(JSON.stringify({ event: 'export.release_failed', exportId }))),
    );
    return settlement;
  };
  const terminalReceipt = (action: 'export.completed' | 'export.failed', counts: ExportCounts) =>
    track(receipt(action, counts).catch(() => console.error(JSON.stringify({ event: 'export.audit_storage_unavailable', exportId, action }))));
  const confirm = (action: 'export.completed' | 'export.failed') =>
    track(
      (lifecycle.onTerminal?.(action) ?? Promise.resolve()).catch(() => console.error(JSON.stringify({ event: 'export.confirm_failed', exportId }))),
    );
  const fail = (reason: NonNullable<ExportCounts['reason']>) => {
    if (state === 'closed') return Promise.resolve();
    state = 'failed';
    producer.abort();
    stopTimers();
    failure ??= track(
      (async () => {
        // A cancellation supersedes a provisional completion draft before either can be published.
        await completion;
        await terminalReceipt('export.failed', { rows, bytes, reason });
        await confirm('export.failed');
        // Publish failure promptly; retain admission until the in-flight read and generator finally settle.
        void cleanup();
      })(),
    );
    return failure;
  };
  function stop(reason: NonNullable<ExportCounts['reason']>, error: Error) {
    if (state === 'closed' || state === 'failed') return;
    void fail(reason);
    controller?.error(error);
  }
  function abort() {
    stop(signal.reason?.code === 'export_lease_expired' ? 'lease_expired' : 'client_aborted', new Error('Export aborted'));
  }
  try {
    await receipt('export.requested', { rows, bytes });
  } catch (error) {
    const reason = failureReason(error);
    await fail(reason === 'export_error' ? 'audit_unavailable' : reason);
    await cleanup();
    throw error;
  }
  signal.addEventListener('abort', abort, { once: true });
  let first: IteratorResult<string, void> | undefined;
  try {
    if (signal.aborted) abort();
    producer.signal.throwIfAborted();
    opening = Promise.resolve(typeof source === 'function' ? source(producer.signal) : source).then((opened) => {
      iterator = opened;
      return opened;
    });
    const opened = await opening;
    producer.signal.throwIfAborted();
    reading = opened.next();
    first = await reading;
    producer.signal.throwIfAborted();
  } catch (error) {
    await fail(signal.aborted ? 'client_aborted' : failureReason(error));
    await cleanup();
    throw error;
  }
  const encoder = new TextEncoder();
  const touch = () => {
    clearTimeout(idle);
    idle = setTimeout(() => stop('idle_timeout', new Error('Export idle timeout')), lifecycle.idleMs ?? 30_000);
    idle.unref?.();
  };
  return new ReadableStream<Uint8Array>({
    start(out) {
      controller = out;
      touch();
      deadline = setTimeout(() => stop('lease_expired', new Error('Export duration limit')), lifecycle.maxDurationMs ?? 15 * 60_000);
      deadline.unref?.();
      if (state === 'failed') out.error(new Error('Export aborted'));
    },
    async pull(out) {
      if (state !== 'streaming') return;
      touch();
      try {
        if (!iterator) throw new Error('Export producer unavailable');
        if (!first) reading = iterator.next();
        const next = first ?? (await reading);
        first = undefined;
        if (failure || !next) return;
        if (next.done) {
          await lifecycle.beforeComplete?.(producer.signal);
          if (failure) return;
          state = 'completing';
          completion = terminalReceipt('export.completed', { rows, bytes, sha256: hash.digest('hex') });
          await completion;
          if (failure) return;
          state = 'closed';
          out.close();
          await confirm('export.completed');
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
        const alreadyFailed = Boolean(failure);
        await fail(signal.aborted ? 'client_aborted' : failureReason(error));
        if (!alreadyFailed) out.error(error);
        await cleanup();
      }
    },
    async cancel() {
      await fail('client_aborted');
      await cleanup();
    },
  });
}
