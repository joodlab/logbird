import { randomUUID } from 'node:crypto';
import { prisma } from '@logbird/database';
import { expect, it, vi } from 'vitest';
import { app } from './app';

const { stage } = vi.hoisted(() => ({ stage: vi.fn().mockResolvedValue(undefined) }));
vi.mock('./auth-failures', () => ({ stageFailedSignIn: stage }));
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
    expect(stage).toHaveBeenCalledTimes(2);
    stage.mockRejectedValueOnce(new Error('Storage unavailable'));
    expect((await request(email)).status).toBe(400);
  } finally {
    await prisma.user.delete({ where: { id } });
  }
});
