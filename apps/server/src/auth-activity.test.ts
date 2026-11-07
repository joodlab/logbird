import { Hono } from 'hono';
import { expect, it, vi } from 'vitest';
import { recordFailedSignIn } from './auth-activity';
import type { AppEnv } from './types';

const { stage } = vi.hoisted(() => ({ stage: vi.fn().mockResolvedValue(undefined) }));
vi.mock('./auth-failures', () => ({ stageFailedSignIn: stage }));
it('durably stages only bounded failed OTP input with safe request context', async () => {
  const app = new Hono<AppEnv>().get('/', async (c) => {
    c.set('requestId', 'request-test');
    await recordFailedSignIn(c, 'member@example.test', Response.json({ code: 'INVALID_OTP' }, { status: 400 }));
    await recordFailedSignIn(c, 'member@example.test', Response.json({ code: 'OTHER' }, { status: 400 }));
    return c.json({ ok: true });
  });
  expect((await app.request('/')).status).toBe(200);
  expect(stage).toHaveBeenCalledOnce();
  expect(stage.mock.calls[0]?.slice(0, 3)).toEqual(['member@example.test', 'invalid_otp', { requestId: 'request-test', ip: '', userAgent: '' }]);
});
