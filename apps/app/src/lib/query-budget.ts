import { ApiRequestError } from '@/lib/api/errors';

/**
 * A query the server stopped because it would scan or hold too much for its range: a ClickHouse budget
 * (`invalid_query` with reason `limit`) or a storage timeout (`query_unavailable`). Narrowing the range helps; an
 * identical retry usually does not.
 */
export function isOverBudget(error: unknown): boolean {
  if (!(error instanceof ApiRequestError)) return false;
  if (error.code === 'query_unavailable') return true;
  if (error.code !== 'invalid_query') return false;
  const reason = (error.details as { reason?: unknown } | undefined)?.reason;
  return reason === 'limit';
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
