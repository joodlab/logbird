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
        expect(await limits.precheck(c)).toBeNull();
        return limits.reject(c);
      });
    expect((await app.request('/valid')).status).toBe(200);
    expect((await app.request('/invalid')).status).toBe(401);
    expect(log).toHaveBeenCalledWith(JSON.stringify({ level: 'error', event: 'rate_limit.storage_error' }));
  } finally {
    log.mockRestore();
  }
});

it('#180: denials across a minute rollover advertise the end of the charged window, not a fresh minute', async () => {
  // The window is captured just before rollover (59.9 s); Redis answers just after it (60.1 s).
  const times = [59_900, 60_100];
  let call = 0;
  const now = () => times[Math.min(call++, times.length - 1)] ?? 60_100;
  const evalScript = vi.fn().mockResolvedValue(99);
  const limits = createPublicRateLimits({ store: { eval: evalScript, get: vi.fn() }, prefix: '{test}', mintLimit: 1, peerLimit: 1, now });
  const app = new Hono<AppEnv>()
    .use('*', async (c, next) => {
      c.set('reader', { via: 'key', keyId: 'k1', keyName: 'k', scope: null, embedOrigins: [] });
      await next();
    })
    .post('/mint', limits.mint(), (c) => c.json({ ok: true }))
    .get('/peer', (c) => limits.reject(c));
  const minted = await app.request('/mint', { method: 'POST' });
  expect(minted.status).toBe(429);
  expect(minted.headers.get('Retry-After')).toBe('1');
  expect(minted.headers.get('RateLimit-Reset')).toBe('1');
  expect(evalScript.mock.calls[0]?.[2]).toBe('{test}:rate:mint:k1:0');
  call = 0;
  const peer = await app.request('/peer');
  expect(peer.status).toBe(429);
  expect(peer.headers.get('Retry-After')).toBe('1');
  expect(String(evalScript.mock.calls[1]?.[2])).toMatch(/:0$/);
});

it('#180: the peer precheck denies with the window it looked up', async () => {
  const times = [59_900, 60_100];
  let call = 0;
  const now = () => times[Math.min(call++, times.length - 1)] ?? 60_100;
  const get = vi.fn().mockResolvedValue('5');
  const limits = createPublicRateLimits({ store: { eval: vi.fn(), get }, prefix: '{test}', peerLimit: 1, now });
  const app = new Hono<AppEnv>().get('/pre', async (c) => (await limits.precheck(c)) ?? c.json({ ok: true }));
  const pre = await app.request('/pre');
  expect(pre.status).toBe(429);
  expect(pre.headers.get('Retry-After')).toBe('1');
  expect(String(get.mock.calls[0]?.[0])).toMatch(/:0$/);
});
