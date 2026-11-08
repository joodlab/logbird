import { setTimeout as sleep } from 'node:timers/promises';

export const EXPORT_FINALIZE_RETRY_MS = 2500;
/** Each attempt releases the writer gate before jittering; only contention is retried. */
export async function retryExportValidation(attempt: () => Promise<void>, signal: AbortSignal, budgetMs = EXPORT_FINALIZE_RETRY_MS) {
  const deadline = performance.now() + budgetMs;
  for (;;) {
    signal.throwIfAborted();
    try {
      return await attempt();
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'export_project_busy') || performance.now() >= deadline)
        throw error;
      await sleep(Math.min(25 + Math.random() * 50, deadline - performance.now()), undefined, { signal });
    }
  }
}

/** A failed renewal consumes the existing lease's slack; it does not claim the lease already expired. */
export function startExportHeartbeat(renew: () => Promise<number>, leaseRemainingMs: number, onExpired: () => void) {
  const intervalMs = 10_000,
    retryMs = 1000,
    safetyMs = 10_000;
  let stopped = false;
  let retry: ReturnType<typeof setTimeout> | undefined, expiry: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    stopped = true;
    clearTimeout(retry);
    clearTimeout(expiry);
  };
  const expire = () => {
    if (!stopped) {
      stop();
      onExpired();
    }
  };
  const guard = (remaining: number) => {
    clearTimeout(expiry);
    expiry = setTimeout(expire, Math.max(0, remaining - safetyMs));
    expiry.unref?.();
  };
  const schedule = (delay: number) => {
    retry = setTimeout(tick, delay);
    retry.unref?.();
  };
  const tick = async () => {
    const started = performance.now();
    try {
      const remaining = await renew();
      if (stopped) return;
      guard(remaining - (performance.now() - started));
      schedule(intervalMs);
    } catch (error) {
      if (stopped) return;
      if (error && typeof error === 'object' && 'code' in error && error.code === 'export_lease_expired') expire();
      else schedule(retryMs);
    }
  };
  guard(leaseRemainingMs);
  schedule(intervalMs);
  return stop;
}
