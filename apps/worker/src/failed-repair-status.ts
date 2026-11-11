type RepairDetails = { fencedProjects: number; oldestFailedAt: string | null };
const TTL_MS = 30_000;
const DEADLINE_MS = 250;

/** Optional probe details: one refresh at a time, including after its caller's deadline expires. */
export function createFailedRepairStatus(load: () => Promise<RepairDetails>) {
  let cached: { at: number; value: RepairDetails } | undefined;
  let inFlight: Promise<void> | undefined;
  let boundedRefresh: Promise<void> | undefined;
  let nextRefreshAt = 0;
  return async () => {
    if (cached && Date.now() - cached.at < TTL_MS) return { ...cached.value, stale: false };
    if (!inFlight && Date.now() >= nextRefreshAt) {
      nextRefreshAt = Date.now() + TTL_MS;
      inFlight = Promise.resolve()
        .then(load)
        .then(
          (value) => {
            cached = { at: Date.now(), value };
          },
          () => undefined,
        )
        .finally(() => {
          inFlight = undefined;
        });
      const pending = inFlight;
      boundedRefresh = new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, DEADLINE_MS);
        void pending.then(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    await boundedRefresh;
    return cached ? { ...cached.value, stale: Date.now() - cached.at >= TTL_MS } : { unavailable: true as const };
  };
}
