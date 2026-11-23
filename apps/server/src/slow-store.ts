/**
 * Limits for the purge-heavy real-service suites (immutable-ingest*, destructive-maintenance, exports, own-audit).
 *
 * Some of their cleanup hooks, waits and test bodies wait on ClickHouse lightweight DELETEs. Each DELETE is applied to
 * every active part of the shared table, so on a long-lived development store with about 100 parts one purge takes
 * 30-40 s (#268). The committed limits fit a small store and stay what CI runs. `LOGBIRD_TEST_SLOW_STORE=1` multiplies
 * only the limits of work that issues a DELETE: the cleanup hooks that purge the fixture, waits on a background DELETE,
 * and the test bodies that run retention, sample removal, project deletion or an ingest recovery that rebuilds rollups.
 * Fixture setup and every other body keep their committed limits, so a stall unrelated to purging still fails on time.
 * Each scaled limit is written as `slowStore(...)` or `purgeLimit(...)` at its call site. Off by default.
 */
export const SLOW_STORE_FACTOR = slowStoreFactor(process.env.LOGBIRD_TEST_SLOW_STORE);

export function slowStoreFactor(raw: string | undefined) {
  // Exactly unset, `0` or `1`: an empty value (a shell variable that expanded to nothing) is refused too.
  if (raw === undefined || raw === '0') return 1;
  // Six times the committed limits: every immutable-ingest* hook passed at 180 s where 30 s timed out.
  if (raw === '1') return 6;
  // A typo must not silently run with the committed limits and report "timeout" as a product failure.
  throw new Error('LOGBIRD_TEST_SLOW_STORE must be 1 (slow store) or unset/0 (committed limits)');
}

/** A purge-related limit in milliseconds: the committed value, multiplied on a slow store. */
export const slowStore = (ms: number) => ms * SLOW_STORE_FACTOR;

/** Test options for a body that issues a DELETE: `it(name, purgeLimit(30_000), async () => { ... })`. */
export const purgeLimit = (ms: number) => ({ timeout: slowStore(ms) });
