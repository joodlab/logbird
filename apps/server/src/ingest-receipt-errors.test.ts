import { apiErrorSchema } from '@logbird/contracts';
import { expect, it } from 'vitest';
import { ingestReceiptFailureResponse, isDatabaseFailure } from './ingest-receipt-errors';

it.each([false, true])('maps a receipt conflict to a retryable 503 (acknowledged=%s)', (acknowledged) => {
  const response = ingestReceiptFailureResponse(
    Object.assign(new Error('private receipt detail'), { code: 'LOGBIRD_INGEST_RECEIPT_CONFLICT' }),
    acknowledged,
  );
  expect(response).toMatchObject({ status: 503, retryAfter: '1', body: { error: { code: acknowledged ? 'ingest_pending' : 'ingest_unavailable' } } });
  expect(apiErrorSchema.parse(response?.body).error.message).not.toMatch(/private receipt detail|time range/);
});

it('leaves other failures to their existing handlers', () => {
  expect(ingestReceiptFailureResponse(new Error('timeout'))).toBeNull();
  expect(ingestReceiptFailureResponse(null)).toBeNull();
  expect(ingestReceiptFailureResponse({ code: '57014' })).toBeNull();
});

it('uses context-neutral retry wording for sample removal and other non-ingest operations', () => {
  const response = ingestReceiptFailureResponse({ code: 'LOGBIRD_INGEST_RECEIPT_CONFLICT' });
  expect(response?.body.error.message).toBe('Event identity cache changed concurrently. Retry this operation.');
});

it.each(['P1001', 'P1002', 'P1008', 'P1017', 'P2024', 'P2034', 'P2028'])('classifies infrastructure Prisma code %s', (code) => {
  expect(isDatabaseFailure({ name: 'PrismaClientKnownRequestError', code })).toBe(true);
});

it.each(['PrismaClientInitializationError', 'PrismaClientRustPanicError'])('classifies %s', (name) => {
  expect(isDatabaseFailure({ name })).toBe(true);
});

const wrapped = (sqlstate: string) => [
  { code: 'P2010', meta: { driverAdapterError: { cause: { originalCode: sqlstate } } } },
  { code: 'P2010', meta: { code: sqlstate } },
  { name: 'DriverAdapterError', cause: { originalCode: sqlstate } },
];

it.each(['08006', '53300', '57014', '57P01', '40001', '40P01', '58030', '55P03'])(
  'classifies infrastructure SQLSTATE %s in every supported wrapper',
  (sqlstate) => {
    for (const error of wrapped(sqlstate)) expect(isDatabaseFailure(error)).toBe(true);
  },
);

it.each(['42601', '42703', '42883', '22P02', '42501', '23505', '23503', '23502'])(
  'does not mask SQL/API error %s in any supported wrapper',
  (sqlstate) => {
    for (const error of wrapped(sqlstate)) expect(isDatabaseFailure(error)).toBe(false);
  },
);

it.each(['DatabaseNotReachable', 'ConnectionClosed', 'SocketTimeout', 'TlsConnectionError', 'TooManyConnections', 'TransactionWriteConflict'])(
  'classifies adapter infrastructure kind %s without a SQLSTATE',
  (kind) => {
    expect(isDatabaseFailure({ name: 'DriverAdapterError', cause: { kind } })).toBe(true);
    expect(isDatabaseFailure({ code: 'P2010', meta: { driverAdapterError: { cause: { kind } } } })).toBe(true);
  },
);

it.each(['ColumnNotFound', 'InvalidInputValue', 'UniqueConstraintViolation', 'AuthenticationFailed', 'postgres'])(
  'does not mask adapter error kind %s',
  (kind) => {
    expect(isDatabaseFailure({ name: 'DriverAdapterError', cause: { kind } })).toBe(false);
    expect(isDatabaseFailure({ code: 'P2010', meta: { driverAdapterError: { cause: { kind } } } })).toBe(false);
  },
);

it('does not let an adapter kind override an explicit programming-error SQLSTATE', () => {
  expect(isDatabaseFailure({ name: 'DriverAdapterError', cause: { kind: 'SocketTimeout', originalCode: '42601' } })).toBe(false);
});

it.each([{ code: 'P2010' }, { code: 'P2002' }, { name: 'PrismaClientUnknownRequestError' }, { name: 'DriverAdapterError' }])(
  'does not classify an unrecognised Prisma error as infrastructure: %o',
  (error) => expect(isDatabaseFailure(error)).toBe(false),
);

it('does not classify programming errors or ClickHouse codes as database failures', () => {
  expect(isDatabaseFailure(new TypeError('undefined is not a function'))).toBe(false);
  expect(isDatabaseFailure({ code: '159' })).toBe(false);
  expect(isDatabaseFailure({ code: 'LOGBIRD_INGEST_RECEIPT_CONFLICT' })).toBe(false);
  expect(isDatabaseFailure(null)).toBe(false);
});
