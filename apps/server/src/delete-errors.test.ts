import { apiErrorSchema } from '@logbird/contracts';
import { expect, it } from 'vitest';
import { deleteFailureResponse } from './delete-errors';

it.each([
  ['LOGBIRD_DELETE_INCOMPLETE', 'Storage did not finish deleting the data. Retry shortly.'],
  ['LOGBIRD_DELETE_UNVERIFIED', 'Storage could not confirm the delete. Retry shortly.'],
])('maps %s to a retryable 503 without time-range advice', (code, message) => {
  const response = deleteFailureResponse(Object.assign(new Error('storage detail'), { code, table: 'events' }));
  expect(response).toEqual({ status: 503, retryAfter: '5', body: { error: { code: 'query_unavailable', message } } });
  expect(apiErrorSchema.parse(response?.body).error.message).not.toMatch(/time range|storage detail/);
});

it('leaves every other error to the generic handlers', () => {
  expect(deleteFailureResponse(Object.assign(new Error('Timeout exceeded'), { code: '159' }))).toBeNull();
  expect(deleteFailureResponse(new Error('LOGBIRD_DELETE_INCOMPLETE'))).toBeNull();
  expect(deleteFailureResponse(null)).toBeNull();
});
