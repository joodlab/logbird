import { LogbirdError } from './errors';

export const ACKNOWLEDGEMENT_BYTES = 4 * 1024 * 1024;
export const READ_RESPONSE_BYTES = 64 * 1024 * 1024;

export function cancelBody(response: Response) {
  return cancelStream(() => response.body?.cancel());
}

function cancelStream(cancel: () => Promise<void> | undefined) {
  try {
    const completion = cancel();
    if (completion) return Promise.resolve(completion).catch(() => undefined);
  } catch {
    // Transport-owned cleanup can fail synchronously as well as reject.
  }
}

export function isRedirect(response: Response, status: number) {
  return response.type === 'opaqueredirect' || (status >= 300 && status < 400);
}

export async function readJson(
  response: Response,
  limit: number,
  signal: AbortSignal,
  status: number,
  onCancel?: (completion: Promise<void>) => void,
): Promise<unknown> {
  let declared: number;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const cancelResponse = () => {
    const completion = cancelBody(response);
    if (completion) onCancel?.(completion);
  };
  try {
    declared = Number(response.headers.get('Content-Length'));
    if (declared <= limit || Number.isNaN(declared)) reader = response.body?.getReader();
  } catch {
    cancelResponse();
    throw new LogbirdError('response_invalid', { status });
  }
  if (declared > limit) {
    cancelResponse();
    throw new LogbirdError('response_too_large', { status });
  }
  if (!reader) throw new LogbirdError('response_invalid', { status });
  const bodyReader = reader;
  let cancellation: Promise<void> | undefined;
  const cancel = () => {
    if (cancellation) return;
    cancellation = cancelStream(() => bodyReader.cancel());
    if (cancellation) onCancel?.(cancellation);
  };
  signal.addEventListener('abort', cancel, { once: true });
  let bytes = new Uint8Array(Math.min(8192, limit));
  let length = 0;
  let consumed = false;
  const tooLarge = Symbol('response too large');
  try {
    signal.throwIfAborted();
    while (true) {
      const { done, value } = await bodyReader.read();
      signal.throwIfAborted();
      if (done) break;
      const next = length + value.byteLength;
      if (next > limit) throw tooLarge;
      if (next > bytes.length) {
        const expanded = new Uint8Array(Math.min(limit, Math.max(next, bytes.length * 2)));
        expanded.set(bytes);
        bytes = expanded;
      }
      bytes.set(value, length);
      length = next;
    }
    consumed = true;
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length))) as unknown;
  } catch (error) {
    throw new LogbirdError(error === tooLarge ? 'response_too_large' : 'response_invalid', { status });
  } finally {
    signal.removeEventListener('abort', cancel);
    if (!consumed) cancel();
    try {
      bodyReader.releaseLock();
    } catch {
      // A transport-owned cleanup failure must never replace the read outcome.
    }
  }
}
