import { ApiRequestError } from '@/lib/api/errors';

/** A confirmed resource limit: the query itself was over budget (never a transient outage). */
export function isBudgetLimit(error: unknown): boolean {
  if (!(error instanceof ApiRequestError) || error.code !== 'invalid_query') return false;
  return (error.details as { reason?: unknown } | undefined)?.reason === 'limit';
}

/**
 * A query the server stopped because it would scan or hold too much for its range: a ClickHouse budget
 * (`invalid_query` with reason `limit`) or a storage timeout (`query_unavailable`). Narrowing the range helps; an
 * identical retry usually does not.
 */
export function isOverBudget(error: unknown): boolean {
  if (!(error instanceof ApiRequestError)) return false;
  // `query_unavailable` also covers transient storage and connection failures; only pages that offer their own
  // Retry treat it as over budget (see `summaryRetry`).
  return error.code === 'query_unavailable' || isBudgetLimit(error);
}

/**
 * What a page made of several independent queries should say about their failures: `budget` when any failed for its
 * range (offer a shorter range), `error` for other failures (offer a retry), or nothing.
 */
export function failureSummary(queries: readonly { isError: boolean; error: unknown }[]): 'budget' | 'error' | null {
  const failed = queries.filter((q) => q.isError);
  if (failed.length === 0) return null;
  return failed.some((q) => isOverBudget(q.error)) ? 'budget' : 'error';
}
