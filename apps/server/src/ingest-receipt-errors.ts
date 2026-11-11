const PRISMA_ERROR_NAMES = new Set([
  'PrismaClientKnownRequestError',
  'PrismaClientUnknownRequestError',
  'PrismaClientInitializationError',
  'PrismaClientRustPanicError',
  'DriverAdapterError',
]);
/**
 * True for a Postgres/Prisma infrastructure failure (timeouts, pool exhaustion, connection loss, statement errors), as
 * opposed to a programming error. Receipt phases map these to retryable 503s; anything else still surfaces as a bug.
 */
export function isDatabaseFailure(error: unknown) {
  if (!error || typeof error !== 'object') return false;
  const name = 'name' in error ? String(error.name) : '';
  const code = 'code' in error ? String(error.code) : '';
  return PRISMA_ERROR_NAMES.has(name) || /^P\d{4}$/.test(code);
}

/** Pure HTTP mapping: a lost receipt CAS is retryable, never an internal error. */
export function ingestReceiptFailureResponse(error: unknown, acknowledged = false) {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  if (code !== 'LOGBIRD_INGEST_RECEIPT_CONFLICT') return null;
  return {
    status: 503 as const,
    retryAfter: '1',
    body: {
      error: {
        code: acknowledged ? 'ingest_pending' : 'ingest_unavailable',
        message: acknowledged
          ? 'Storage accepted this write but receipt confirmation is unresolved. Retry this batch.'
          : 'Event identity cache changed concurrently. Retry this operation.',
      },
    },
  };
}
