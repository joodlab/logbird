import { LogbirdError } from './errors';

export const ACKNOWLEDGEMENT_BYTES = 4 * 1024 * 1024;
export const READ_RESPONSE_BYTES = 64 * 1024 * 1024;

export function cancelBody(response: Response) {
  return response.body?.cancel().catch(() => undefined);
}

export function isRedirect(response: Response) {
  return response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400);
}

export async function readJson(
  response: Response,
  limit: number,
  signal: AbortSignal,
  onCancel?: (completion: Promise<void>) => void,
): Promise<unknown> {
  if (Number(response.headers.get('Content-Length')) > limit) {
    const completion = cancelBody(response);
    if (completion) onCancel?.(completion);
    throw new LogbirdError('response_too_large');
  }
  if (!response.body) throw new LogbirdError('response_invalid');
  const reader = response.body.getReader();
  let cancellation: Promise<void> | undefined;
  const cancel = () => {
    if (cancellation) return;
    cancellation = reader.cancel().catch(() => undefined);
    onCancel?.(cancellation);
  };
  signal.addEventListener('abort', cancel, { once: true });
  let bytes = new Uint8Array(Math.min(8192, limit));
  let length = 0;
  let consumed = false;
  try {
    signal.throwIfAborted();
    while (true) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      const next = length + value.byteLength;
      if (next > limit) throw new LogbirdError('response_too_large');
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
    if (signal.aborted || (error instanceof LogbirdError && error.code === 'response_too_large')) throw error;
    throw new LogbirdError('response_invalid');
  } finally {
    signal.removeEventListener('abort', cancel);
    if (!consumed) cancel();
    reader.releaseLock();
  }
}
