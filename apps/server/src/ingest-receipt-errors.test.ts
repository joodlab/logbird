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

it.each([
  Object.assign(new Error('pool timeout'), { name: 'PrismaClientKnownRequestError', code: 'P2024' }),
  Object.assign(new Error('cannot reach database'), { name: 'PrismaClientInitializationError' }),
  Object.assign(new Error('statement timeout'), { code: 'P2010' }),
  Object.assign(new Error('adapter'), { name: 'DriverAdapterError' }),
])('classifies Prisma and driver failures as database failures (%s)', (error) => {
  expect(isDatabaseFailure(error)).toBe(true);
});

it('does not classify programming errors or ClickHouse codes as database failures', () => {
  expect(isDatabaseFailure(new TypeError('undefined is not a function'))).toBe(false);
  expect(isDatabaseFailure({ code: '159' })).toBe(false);
  expect(isDatabaseFailure({ code: 'LOGBIRD_INGEST_RECEIPT_CONFLICT' })).toBe(false);
  expect(isDatabaseFailure(null)).toBe(false);
});
