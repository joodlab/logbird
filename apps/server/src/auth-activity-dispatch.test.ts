import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { app } from './app';

const { record } = vi.hoisted(() => ({ record: vi.fn() }));
vi.mock('./auth-activity', () => ({ recordFailedSignIn: record }));

it('returns the failed-auth response while membership lookup/audit storage is still blocked', async () => {
  let release: () => void = () => undefined;
  record.mockReturnValue(
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const response = app.request(
    '/api/auth/sign-in/email-otp',
    {
      method: 'POST',
      headers: { Origin: process.env.APP_URL ?? 'http://localhost:4600', 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: `qa-fix-dispatch-${randomUUID()}@example.test`, otp: '000000' }),
    },
    { incoming: { socket: { remoteAddress: '203.0.113.77' } } },
  );
  try {
    const result = await Promise.race([
      response,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Auth response waited for audit storage')), 5000);
      }),
    ]);
    expect(result.status).toBe(400);
    expect((await result.json()).code).toBe('INVALID_OTP');
    await vi.waitFor(() => expect(record).toHaveBeenCalledOnce());
    const auditResponse = record.mock.calls[0]?.[2] as Response;
    expect((await auditResponse.json()).code).toBe('INVALID_OTP');
  } finally {
    clearTimeout(timer);
    release();
    await response;
  }
}, 10_000);
