import { type TestFunction, afterEach as vitestAfterEach, it as vitestIt } from 'vitest';

/**
 * Limits for the purge-heavy real-service suites (immutable-ingest*, destructive-maintenance, exports, own-audit).
 *
 * Some of their hooks, waits and bodies wait on ClickHouse lightweight DELETEs. Each DELETE is applied to every active
 * part of the shared table, so on a long-lived development store with about 100 parts one purge takes 30-40 s (#268).
 * The committed limits fit a small store and stay what CI runs. `LOGBIRD_TEST_SLOW_STORE=1` multiplies only the limits
 * of work that waits for a purge: cleanup hooks, waits on a background DELETE, and the bodies that run retention,
 * sample removal, project deletion or a rollup rebuild. A file-wide body limit scales only where every body purges;
 * any other body keeps its committed limit, so a stall unrelated to purging still fails on time. Off by default.
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

/**
 * Vitest's `it`, except that an explicit per-test limit (the third argument) is a purge-related limit and scales. Call
 * sites keep their numeric literal, so the formatter keeps the test body where it is.
 */
export const it: ((name: string, fn: TestFunction, timeout?: number) => void) & { each: typeof vitestIt.each } = Object.assign(
  (name: string, fn: TestFunction, timeout?: number) => vitestIt(name, fn, timeout === undefined ? undefined : slowStore(timeout)),
  { each: vitestIt.each.bind(vitestIt) },
);

type Hook = (fn: () => unknown, timeout?: number) => void;
/** Vitest's `afterEach`, with an explicit limit scaled: these suites' per-test cleanups purge. */
export const afterEach: Hook = (fn, timeout) => vitestAfterEach(fn, timeout === undefined ? undefined : slowStore(timeout));
