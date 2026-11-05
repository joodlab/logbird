import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { expect, it } from 'vitest';
import { ApiError } from './errors';
import { inviteRateLimit } from './invite-rate-limit';

it('limits each peer and route independently and returns the standard error', async () => {
  const app = new Hono();
  const limit = inviteRateLimit(1);
  app.onError((e, c) => (e instanceof ApiError ? c.json({ error: { code: e.code, message: e.message } }, e.status) : c.text('unexpected', 500)));
  app.get('/preview/:token', limit, (c) => c.text('ok'));
  app.post('/accept/:token', limit, (c) => c.text('ok'));
  const namespace = randomUUID();
  const request = (path: string, ip: string, method = 'GET') =>
    app.request(path, { method }, { incoming: { socket: { remoteAddress: `${namespace}:${ip}` } } });
  expect((await request('/preview/a', '1')).status).toBe(200);
  const blocked = await request('/preview/b', '1');
  expect(blocked.status).toBe(429);
  expect(blocked.headers.get('Retry-After')).toBeTruthy();
  expect(await blocked.json()).toMatchObject({ error: { code: 'rate_limited' } });
  expect((await request('/preview/a', '2')).status).toBe(200);
  expect((await request('/accept/a', '1', 'POST')).status).toBe(200);
});
