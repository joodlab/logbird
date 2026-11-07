import type { Context } from 'hono';
import { stageFailedSignIn } from './auth-failures';
import { env } from './env';
import { clientAddress } from './rate-limit';
import type { AppEnv } from './types';

const failureReasons = { INVALID_OTP: 'invalid_otp', OTP_EXPIRED: 'expired_otp', TOO_MANY_ATTEMPTS: 'locked_out' } as const;

export async function recordFailedSignIn(c: Context<AppEnv>, email: unknown, response: Response) {
  if (typeof email !== 'string' || email.length > 254 || !email.includes('@')) return;
  const result = await response
    .clone()
    .json()
    .catch(() => null);
  const reason = failureReasons[result?.code as keyof typeof failureReasons];
  if (!reason) return;
  try {
    await stageFailedSignIn(
      email,
      reason,
      { requestId: c.get('requestId'), ip: clientAddress(c) ?? '', userAgent: c.req.header('user-agent') ?? '' },
      env.BETTER_AUTH_SECRET,
    );
  } catch {
    console.error(JSON.stringify({ event: 'auth.audit_storage_unavailable', requestId: c.get('requestId') }));
  }
}
