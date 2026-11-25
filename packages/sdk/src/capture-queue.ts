import type { EventInput } from './index';

/** The integration and client share one capacity and shutdown budget without exposing preparation as public API. */
export const captureQueue = new WeakMap<
  object,
  (identity: EventInput, prepare: () => Promise<EventInput>, onFailure: () => void) => Promise<void> | undefined
>();
