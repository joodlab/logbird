import { apiErrorSchema } from '@logbird/contracts';
import { expect, it } from 'vitest';
import { app } from './app';

app.get('/_test/budget', () => {
  throw Object.assign(new Error('Timeout exceeded'), { code: '159' });
});
app.get('/_test/query', () => {
  throw new Error('Invalid cursor');
});
app.get('/_test/internal', () => {
  throw new Error('Internal processor error with private details');
});
it('reports storage budget exhaustion as 503 and malformed cursors as 422', async () => {
  const unavailable = await app.request('/_test/budget');
  expect(unavailable.status).toBe(503);
  expect(apiErrorSchema.parse(await unavailable.json()).error.code).toBe('query_unavailable');
  const invalid = await app.request('/_test/query');
  expect(invalid.status).toBe(422);
  expect(apiErrorSchema.parse(await invalid.json()).error.code).toBe('invalid_query');
});
it('does not expose arbitrary internal errors as query validation failures', async () => {
  const result = await app.request('/_test/internal');
  expect(result.status).toBe(500);
  expect(JSON.stringify(await result.json())).not.toContain('private details');
});
