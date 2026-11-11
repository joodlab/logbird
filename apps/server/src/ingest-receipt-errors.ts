const INFRASTRUCTURE_CODES = new Set(['P1001', 'P1002', 'P1008', 'P1011', 'P1017', 'P2024', 'P2034', 'P2028', 'P2037']);
// Exact kinds emitted by Prisma 7's adapter-pg (including kinds whose SQLSTATE may be absent).
const INFRASTRUCTURE_KINDS = new Set([
  'DatabaseNotReachable',
  'ConnectionClosed',
  'SocketTimeout',
  'TlsConnectionError',
  'TooManyConnections',
  'TransactionWriteConflict',
]);
// adapter-pg rethrows pg errors without a SQLSTATE or socket code unchanged, and Prisma passes them through. These
// are pg 8 / pg-pool's fixed connection-loss and timeout messages (node_modules/pg/lib, pg-pool/index.js).
const PG_CONNECTION_MESSAGES = new Set([
  'Connection terminated',
  'Connection terminated unexpectedly',
  'Connection terminated due to connection timeout',
  'Client has encountered a connection error and is not queryable',
  'Client was closed and is not queryable',
  'Query read timeout',
  'timeout expired',
  'timeout exceeded when trying to connect',
]);
const record = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' ? (value as Record<string, unknown>) : {});
const text = (value: unknown) => (typeof value === 'string' ? value : undefined);

function adapterCause(error: unknown) {
  const source = record(error);
  return record(record(record(source.meta).driverAdapterError).cause ?? source.cause);
}

/** Safe error metadata only; never include messages, SQL or event payloads. */
export function receiptErrorDetails(error: unknown) {
  const source = record(error);
  return { name: text(source.name), code: text(source.code), kind: text(adapterCause(error).kind) };
}
/**
 * True for a Postgres/Prisma infrastructure failure (timeouts, pool exhaustion, connection loss), as
 * opposed to a programming error. Receipt phases map these to retryable 503s; anything else still surfaces as a bug.
 */
export function isDatabaseFailure(error: unknown) {
  const { name, code, kind } = receiptErrorDetails(error);
  if (name === 'PrismaClientInitializationError' || name === 'PrismaClientRustPanicError') return true;
  if (code && INFRASTRUCTURE_CODES.has(code)) return true;
  // Exact match on a plain Error only: a Prisma class, a coded error or a reworded message never qualifies.
  if (error instanceof Error && error.constructor === Error && code === undefined && PG_CONNECTION_MESSAGES.has(error.message)) return true;
  if (code !== 'P2010' && code !== 'P2039' && name !== 'DriverAdapterError') return false;
  const source = record(error);
  const sqlstate = text(adapterCause(error).originalCode) ?? text(record(source.meta).code);
  // An explicit SQLSTATE takes precedence over a contradictory adapter kind.
  if (sqlstate) return /^(08|53|57|40|58)[0-9A-Z]{3}$/.test(sqlstate) || ['55P03', '25P03', '25P04'].includes(sqlstate);
  return kind !== undefined && INFRASTRUCTURE_KINDS.has(kind);
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
