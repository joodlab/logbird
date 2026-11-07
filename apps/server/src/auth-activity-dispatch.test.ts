import { randomUUID } from 'node:crypto';
import { prisma } from '@logbird/database';
import { expect, it } from 'vitest';
import { app } from './app';
import { authEmailHash } from './auth-failures';
import { env } from './env';

it('known and unknown identities receive byte-identical failed-auth responses and await the same durable stage', async () => {
  const id = randomUUID();
  const email = `qa-fix-dispatch-${id}@example.test`;
  await prisma.user.create({ data: { id, name: 'QA Dispatch Member', email } });
  const request = (email: string) =>
    app.request(
      '/api/auth/sign-in/email-otp',
      {
        method: 'POST',
        headers: { Origin: process.env.APP_URL ?? 'http://localhost:4600', 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, otp: '000000' }),
      },
      { incoming: { socket: { remoteAddress: '203.0.113.77' } } },
    );
  try {
    const known = await request(email);
    const unknown = await request(`qa-fix-unknown-${id}@example.test`);
    expect(known.status).toBe(400);
    expect(unknown.status).toBe(known.status);
    expect(await known.text()).toBe(await unknown.text());
    const hashes = [email, `qa-fix-unknown-${id}@example.test`].map((email) => authEmailHash(email, env.BETTER_AUTH_SECRET));
    const windows = await prisma.authAuditWindow.findMany({ where: { emailHash: { in: hashes } } });
    expect(windows).toHaveLength(2);
    expect(windows.every((row) => row.attempts === 1 && row.identity === '')).toBe(true);
    expect(JSON.stringify(windows)).not.toContain('@example.test');
  } finally {
    await prisma.authAuditWindow.deleteMany({
      where: { emailHash: { in: [email, `qa-fix-unknown-${id}@example.test`].map((email) => authEmailHash(email, env.BETTER_AUTH_SECRET)) } },
    });
    await prisma.user.delete({ where: { id } });
  }
});
