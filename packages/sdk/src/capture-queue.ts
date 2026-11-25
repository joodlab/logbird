import { LogbirdError } from './errors';
import type { EventInput } from './index';

interface CaptureQueue {
  defer(identity: EventInput, prepare: () => Promise<EventInput>, onFailure: (error: LogbirdError) => void): Promise<void> | undefined;
  notify(callback: ((error: LogbirdError) => void) | undefined, error: unknown): void;
}

// The client and its adapter can resolve the same SDK version from different installed copies.
const captureQueue = Symbol.for('@logbird/sdk/capture-queue/v1');

export function attachCaptureQueue(client: object, queue: CaptureQueue) {
  Object.defineProperty(client, captureQueue, { value: queue });
}

export function getCaptureQueue(client: object): CaptureQueue {
  const queue = Reflect.get(client, captureQueue) as CaptureQueue | undefined;
  if (!queue) throw new LogbirdError('capture_incompatible_client');
  return queue;
}
