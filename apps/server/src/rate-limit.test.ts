import { Hono } from 'hono';
import { afterAll, expect, it, vi } from 'vitest';
import { createPublicRateLimits, rateLimitStore } from './rate-limit';
import type { AppEnv } from './types';

const project = { id: 'fictional-project' } as AppEnv['Variables']['project'];
afterAll(() => rateLimitStore.quit());
it('uses project/kind/window keys and returns decreasing/reset headers across routes', async () => {
  const evalScript = vi.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(2).mockResolvedValueOnce(3).mockResolvedValue(1);
  let time = 61_000;
  const limits = createPublicRateLimits({ store: { eval: evalScript, get: vi.fn() }, prefix: '{test}', ingestLimit: 2, now: () => time });
  const app = new Hono<AppEnv>()
    .use('*', async (c, next) => {
      c.set('project', project);
      await next();
    })
    .use('*', limits.authenticated('ingest'))
    .get('*', (c) => c.json({ ok: true }));
  const first = await app.request('/one');
  expect(first.headers.get('RateLimit-Limit')).toBe('2');
  expect(first.headers.get('RateLimit-Remaining')).toBe('1');
  expect(first.headers.get('RateLimit-Reset')).toBe('59');
  expect((await app.request('/two')).headers.get('RateLimit-Remaining')).toBe('0');
  const denied = await app.request('/one');
  expect(denied.status).toBe(429);
  expect(denied.headers.get('Retry-After')).toBe('59');
  expect(await denied.json()).toEqual({ error: { code: 'rate_limited', message: 'Too many requests. Retry shortly.' } });
  expect(evalScript.mock.calls[0]?.slice(1)).toEqual([1, '{test}:rate:project:fictional-project:ingest:1', 120_000]);
  expect(evalScript.mock.calls[1]?.[2]).toBe(evalScript.mock.calls[0]?.[2]);
  time = 120_000;
  await app.request('/one');
  expect(evalScript.mock.calls[3]?.[2]).toBe('{test}:rate:project:fictional-project:ingest:2');
});
it('fails open and logs storage errors, including abuse protection', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    const limits = createPublicRateLimits({
      store: { eval: vi.fn().mockRejectedValue(new Error('offline')), get: vi.fn().mockRejectedValue(new Error('offline')) },
    });
    const app = new Hono<AppEnv>()
      .use('*', async (c, next) => {
        c.set('project', project);
        await next();
      })
      .get('/valid', limits.authenticated('read'), (c) => c.json({ ok: true }))
      .get('/invalid', async (c) => {
        expect(await limits.precheck(c)).toBe(false);
        return limits.reject(c);
      });
    expect((await app.request('/valid')).status).toBe(200);
    expect((await app.request('/invalid')).status).toBe(401);
    expect(log).toHaveBeenCalledWith(JSON.stringify({ level: 'error', event: 'rate_limit.storage_error' }));
  } finally {
    log.mockRestore();
  }
});
