export type ExportReceipt = (
  action: 'export.requested' | 'export.completed' | 'export.failed',
  counts: {
    rows: number;
    bytes: number;
    reason?: 'client_aborted' | 'export_error';
  },
) => Promise<unknown>;

/** Counts describe bytes handed to the response stream, not client acknowledgement or durable download. */
export async function auditedExport(iterator: AsyncGenerator<string, void>, csv: boolean, receipt: ExportReceipt, signal: AbortSignal) {
  let rows = 0;
  let bytes = 0;
  let header = csv;
  let terminal: Promise<unknown> | undefined;
  const finish = (action: 'export.completed' | 'export.failed', reason?: 'client_aborted' | 'export_error') => {
    terminal ??= receipt(action, { rows, bytes, ...(reason ? { reason } : {}) });
    return terminal;
  };
  // Fail closed: no event bytes are read or sent without a stored requested receipt.
  await receipt('export.requested', { rows, bytes });
  let first: IteratorResult<string> | undefined;
  try {
    if (signal.aborted) throw new Error('Export aborted');
    first = await iterator.next();
  } catch (error) {
    try {
      await finish('export.failed', signal.aborted ? 'client_aborted' : 'export_error');
    } finally {
      await iterator.return();
    }
    throw error;
  }
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const abort = () => {
    void finish('export.failed', 'client_aborted').catch(() => console.error('export.audit_failed'));
    controller.error(new Error('Export aborted'));
    void iterator.return().catch(() => console.error('export.cleanup_failed'));
  };
  return new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    },
    async pull(out) {
      if (terminal) return;
      try {
        const next = first ?? (await iterator.next());
        first = undefined;
        if (terminal) return;
        if (next.done) {
          await finish('export.completed');
          signal.removeEventListener('abort', abort);
          out.close();
          return;
        }
        const chunk = encoder.encode(next.value);
        out.enqueue(chunk);
        bytes += chunk.byteLength;
        if (header) header = false;
        else rows++;
      } catch (error) {
        try {
          if (!terminal) await finish('export.failed', signal.aborted ? 'client_aborted' : 'export_error');
        } finally {
          signal.removeEventListener('abort', abort);
          out.error(error);
          await iterator.return();
        }
      }
    },
    async cancel() {
      signal.removeEventListener('abort', abort);
      try {
        await finish('export.failed', 'client_aborted');
      } finally {
        await iterator.return();
      }
    },
  });
}
