/**
 * HTTP mapping for verified-delete failures from @logbird/clickhouse deleteAndVerify. Pure (no env, no services) so
 * CI's unit job can test it. Both are retryable 503s; neither gets time-range advice, which does not apply to a delete.
 */
const DELETE_FAILURES: Record<string, string> = {
  LOGBIRD_DELETE_INCOMPLETE: 'Storage did not finish deleting the data. Retry shortly.',
  LOGBIRD_DELETE_UNVERIFIED: 'Storage could not confirm the delete. Retry shortly.',
};

export function deleteFailureResponse(error: unknown) {
  const code = error && typeof error === 'object' && 'code' in error ? (error as { code?: unknown }).code : undefined;
  const message = typeof code === 'string' && Object.hasOwn(DELETE_FAILURES, code) ? DELETE_FAILURES[code] : undefined;
  return message ? { status: 503 as const, retryAfter: '5', body: { error: { code: 'query_unavailable', message } } } : null;
}
