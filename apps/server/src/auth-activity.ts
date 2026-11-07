import { createHmac } from 'node:crypto';
import { prisma } from '@logbird/database';
import type { Context } from 'hono';
import { env } from './env';
import { ingest } from './ingest';
import { clientAddress, rateLimitStore } from './rate-limit';
import type { AppEnv } from './types';

const failureReasons = { INVALID_OTP: 'invalid_otp', OTP_EXPIRED: 'expired_otp', TOO_MANY_ATTEMPTS: 'locked_out' } as const;

/** Audit rate limiting is separate from authentication: never change the auth response or expose account membership. */
export async function recordFailedSignIn(c: Context<AppEnv>, email: unknown, response: Response) {
  if (typeof email !== 'string' || email.length > 254 || !email.includes('@')) return;
  const result = await response
    .clone()
    .json()
    .catch(() => null);
  const reason = failureReasons[result?.code as keyof typeof failureReasons];
  if (!reason) return;
  const normalized = email.trim().toLowerCase();
  const emailHash = createHmac('sha256', env.BETTER_AUTH_SECRET).update(normalized).digest('hex');
  // One receipt per account/reason per five minutes across replicas and IPs. Lockout has its own budget.
  const key = `${env.BULLMQ_PREFIX}:auth-audit:${emailHash}:${reason}`;
  if ((await rateLimitStore.set(key, '1', 'EX', 300, 'NX')) !== 'OK') return;
  const context = { requestId: c.get('requestId'), ip: clientAddress(c) ?? '', userAgent: c.req.header('user-agent') ?? '' };
  // Unknown/pre-membership identities have no workspace. Keep the same redacted security log for every identity.
  console.warn(JSON.stringify({ event: 'auth.sign_in.failed', emailHash, reason, ...context }));
  const user = await prisma.user.findUnique({ where: { email: normalized }, select: { id: true } });
  if (!user) return;
  for (const member of await prisma.member.findMany({ where: { userId: user.id } }))
    await ingest(`ws:${member.organizationId}`, {
      action: 'auth.sign_in.failed',
      outcome: 'failure',
      severity: 'warning',
      actor: { type: 'anonymous', id: emailHash, name: 'Unverified sign-in' },
      targets: [{ type: 'sign_in', id: emailHash }],
      context,
      metadata: { emailHash, reason, auditWindowSeconds: 300 },
    });
}
