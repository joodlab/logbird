import { apiErrorSchema } from '@logbird/contracts';
import { expect, it } from 'vitest';
import { app } from './app';

app.get('/_test/budget', () => {
  throw Object.assign(new Error('Timeout exceeded'), { code: '159' });
});
app.get('/_test/query', () => {
  throw new Error('Invalid cursor');
});
app.get('/_test/delete', () => {
  throw Object.assign(new Error('Delete left visible rows in events after 3 attempts.'), { code: 'LOGBIRD_DELETE_INCOMPLETE', table: 'events' });
});
app.get('/_test/delete-unverified', () => {
  throw Object.assign(new Error('Could not verify the delete in events (attempt 1). Retry the operation.', { cause: new Error('Timeout') }), {
    code: 'LOGBIRD_DELETE_UNVERIFIED',
    table: 'events',
  });
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
it.each(['/_test/delete', '/_test/delete-unverified'])(
  'reports a failed verified delete (%s) as a retryable 503 without range advice',
  async (path) => {
    const result = await app.request(path);
    expect(result.status).toBe(503);
    expect(result.headers.get('Retry-After')).toBe('5');
    const body = apiErrorSchema.parse(await result.json());
    expect(body.error.code).toBe('query_unavailable');
    expect(body.error.message).not.toMatch(/time range/);
  },
);
