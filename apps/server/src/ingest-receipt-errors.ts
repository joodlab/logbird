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
