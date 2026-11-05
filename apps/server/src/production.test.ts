import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { expect, it } from 'vitest';
import { app } from './app';
import { rateLimit } from './rate-limit';

it('keeps liveness independent of dependencies and applies security headers', async () => {
  const response = await app.request('/livez');
  expect(response.status).toBe(200);
  expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  expect(await response.json()).toEqual({ status: 'ok' });
});
it('does not grant CORS to an unconfigured origin', async () => {
  const response = await app.request('/livez', { headers: { Origin: 'https://untrusted.example' } });
  expect(response.headers.get('access-control-allow-origin')).toBeNull();
});
it('shares atomic auth limits across middleware instances using real Redis', async () => {
  const first = new Hono().use('*', rateLimit).get('/api/auth/probe', (c) => c.text('ok'));
  const second = new Hono().use('*', rateLimit).get('/api/auth/probe', (c) => c.text('ok'));
  const bindings = { incoming: { socket: { remoteAddress: randomUUID() } } };
  for (let i = 0; i < 30; i++) {
    const response = await first.request('/api/auth/probe', {}, bindings);
    expect(response.status).toBe(200);
  }
  const blocked = await second.request('/api/auth/probe', {}, bindings);
  expect(blocked.status).toBe(429);
  expect(blocked.headers.get('retry-after')).toBe('60');
});

it('returns a structured error for oversized management requests', async () => {
  const response = await app.request('/api/auth/probe', { method: 'POST', headers: { 'Content-Length': String(6 * 1024 * 1024) }, body: 'x' });
  expect(response.status).toBe(413);
  expect(await response.json()).toEqual({ error: { code: 'payload_too_large', message: 'Request exceeds 5 MB.' } });
});
