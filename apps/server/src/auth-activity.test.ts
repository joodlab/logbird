import { createHmac } from 'node:crypto';
import { Hono } from 'hono';
import { beforeEach, expect, it, vi } from 'vitest';
import { recordFailedSignIn } from './auth-activity';
import type { AppEnv } from './types';

const mocks = vi.hoisted(() => ({ set: vi.fn(), user: vi.fn(), memberships: vi.fn(), ingest: vi.fn() }));
vi.mock('@logbird/database', () => ({ prisma: { user: { findUnique: mocks.user }, member: { findMany: mocks.memberships } } }));
vi.mock('./env', () => ({ env: { BETTER_AUTH_SECRET: 'fictional-unit-test-secret', BULLMQ_PREFIX: '{unit-auth-audit}' } }));
vi.mock('./ingest', () => ({ ingest: mocks.ingest }));
vi.mock('./rate-limit', () => ({ clientAddress: () => '203.0.113.70', rateLimitStore: { set: mocks.set } }));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.set.mockResolvedValue('OK');
  mocks.user.mockResolvedValue({ id: 'user' });
  mocks.memberships.mockResolvedValue([{ organizationId: 'workspace' }]);
  mocks.ingest.mockResolvedValue(undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

function failure(email: unknown, code = 'INVALID_OTP') {
  return new Hono<AppEnv>()
    .post('/failure', async (c) => {
      c.set('requestId', 'test-request');
      const response = Response.json({ code, message: 'Invalid OTP' }, { status: 400 });
      await recordFailedSignIn(c, email, response);
      return response;
    })
    .request('/failure', { method: 'POST' });
}

it('records unverified identity as a keyed hash, keeps IP/request correlation, and preserves the auth response', async () => {
  const response = await failure(' Person@example.test ');
  expect(await response.json()).toEqual({ code: 'INVALID_OTP', message: 'Invalid OTP' });
  const digest = createHmac('sha256', 'fictional-unit-test-secret').update('person@example.test').digest('hex');
  expect(mocks.set).toHaveBeenCalledWith(`{unit-auth-audit}:auth-audit:${digest}:invalid_otp`, '1', 'EX', 300, 'NX');
  expect(mocks.ingest).toHaveBeenCalledWith(
    'ws:workspace',
    expect.objectContaining({
      action: 'auth.sign_in.failed',
      outcome: 'failure',
      actor: { type: 'anonymous', id: digest, name: 'Unverified sign-in' },
      context: expect.objectContaining({ requestId: 'test-request', ip: '203.0.113.70' }),
    }),
  );
  expect(JSON.stringify(mocks.ingest.mock.calls)).not.toContain('person@example.test');
});

it('suppresses repeated failures before identity lookup but gives lockouts a distinct budget', async () => {
  mocks.set.mockResolvedValueOnce(null);
  await failure('person@example.test');
  expect(mocks.user).not.toHaveBeenCalled();
  expect(mocks.ingest).not.toHaveBeenCalled();
  await failure('person@example.test', 'TOO_MANY_ATTEMPTS');
  expect(mocks.set.mock.calls.at(-1)?.[0]).toMatch(/:locked_out$/);
  expect(mocks.ingest.mock.calls.at(-1)?.[1].metadata.reason).toBe('locked_out');
});

it('does not invent a workspace or change responses for unknown users, malformed emails or non-OTP failures', async () => {
  mocks.user.mockResolvedValue(null);
  expect((await failure('unknown@example.test')).status).toBe(400);
  expect(mocks.ingest).not.toHaveBeenCalled();
  mocks.set.mockClear();
  await failure(null);
  await failure('bad-email');
  await failure('person@example.test', 'UNRELATED_ERROR');
  expect(mocks.set).not.toHaveBeenCalled();
});
