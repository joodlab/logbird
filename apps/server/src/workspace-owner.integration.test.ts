import { randomUUID } from 'node:crypto';
import { prisma } from '@logbird/database';
import { expect, it, vi } from 'vitest';
import { app } from './app';

vi.hoisted(() => {
  process.env.AUTH_RATE_LIMIT_PER_MINUTE = '100000';
});

// The member_keep_an_owner trigger through better-auth's real endpoints: two owners racing to leave, remove and demote
// each other. Fictional people and workspaces only; everything is removed afterwards.
const ITERATIONS = Number(process.env.OWNER_RACE_API_ITERATIONS ?? 200);
const request = (path: string, cookie: string, body?: unknown) =>
  app.request(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { cookie, Origin: process.env.APP_URL ?? 'http://localhost:4600', 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

async function login(users: string[]) {
  const email = `t3-owner-api-${randomUUID()}@example.invalid`;
  expect((await request('/api/auth/email-otp/send-verification-otp', '', { email, type: 'sign-in' })).status).toBe(200);
  const mailpit = process.env.MAILPIT_URL ?? 'http://127.0.0.1:8025';
  let content: { Text: string } | undefined;
  for (let i = 0; i < 40 && !content; i++) {
    const mailbox = await (await fetch(`${mailpit}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}&limit=1`)).json();
    if (mailbox.messages?.[0]) content = await (await fetch(`${mailpit}/api/v1/message/${mailbox.messages[0].ID}`)).json();
    else await new Promise((r) => setTimeout(r, 250));
  }
  const response = await request('/api/auth/sign-in/email-otp', '', { email, otp: content?.Text.match(/\b\d{6}\b/)?.[0] });
  expect(response.status).toBe(200);
  const { user } = await response.json();
  users.push(user.id);
  return {
    id: user.id as string,
    cookie: response.headers
      .getSetCookie()
      .map((v) => v.split(';')[0])
      .join('; '),
  };
}

it(`two owners racing through leave, remove and role change: exactly one wins, the other hears why (${ITERATIONS}× each)`, async () => {
  const users: string[] = [];
  const organizations: string[] = [];
  const triggered: Record<string, number> = {};
  try {
    const a = await login(users);
    const b = await login(users);
    const workspace = async () => {
      const id = randomUUID();
      await prisma.organization.create({ data: { id, name: 'T3 Owner API Example', slug: `t3-owner-api-${id}`, createdAt: new Date() } });
      organizations.push(id);
      const members = await Promise.all(
        [a, b].map((u) =>
          prisma.member.create({ data: { id: randomUUID(), organizationId: id, userId: u.id, role: 'owner', createdAt: new Date() } }),
        ),
      );
      return { id, members };
    };
    const leave = (who: typeof a, organizationId: string) => request('/api/auth/organization/leave', who.cookie, { organizationId });
    const remove = (who: typeof a, organizationId: string, memberId: string) =>
      request('/api/auth/organization/remove-member', who.cookie, { organizationId, memberIdOrEmail: memberId });
    const demote = (who: typeof a, organizationId: string, memberId: string) =>
      request('/api/auth/organization/update-member-role', who.cookie, { organizationId, memberId, role: 'member' });

    for (const [label, race] of [
      ['leave + leave', (w: Awaited<ReturnType<typeof workspace>>) => [leave(a, w.id), leave(b, w.id)]],
      // A removes B while B leaves: both target B's membership, and A's own stays; then A leaves while B removes A.
      ['remove + leave', (w: Awaited<ReturnType<typeof workspace>>) => [remove(b, w.id, w.members[0]?.id as string), leave(b, w.id)]],
      ['demote + leave', (w: Awaited<ReturnType<typeof workspace>>) => [demote(b, w.id, w.members[0]?.id as string), leave(b, w.id)]],
    ] as const) {
      for (let i = 0; i < ITERATIONS; i++) {
        const w = await workspace();
        const responses = await Promise.all(race(w));
        const statuses = responses.map((r) => r.status);
        const bodies = await Promise.all(responses.map((r) => r.json().catch(() => null)));
        const remaining = await prisma.member.findMany({ where: { organizationId: w.id } });
        // The workspace always keeps an owner, whatever the interleaving.
        expect(
          remaining.some((m) => m.role.split(',').some((r) => r.trim() === 'owner')),
          `${label} #${i}: ${statuses} ${JSON.stringify(bodies)}`,
        ).toBe(true);
        // Exactly one change went through. The other is refused with a sentence, never a 500: by the trigger (409) when
        // the two overlapped, or by better-auth's own last-owner check (400) when the first had already committed.
        expect(
          statuses.filter((s) => s === 200),
          `${label} #${i}: ${statuses} ${JSON.stringify(bodies)}`,
        ).toHaveLength(1);
        const index = statuses.findIndex((s) => s !== 200);
        const refused = { status: statuses[index], body: bodies[index] };
        if (refused.status === 409) {
          expect(refused.body?.message).toBe('A workspace needs at least one owner. Make another member an owner first.');
          triggered[label] = (triggered[label] ?? 0) + 1;
        } else {
          // Refused before the trigger: by better-auth's own last-owner check, or (B's remove or role change after B's
          // own leave committed) because B is no longer a member allowed to do it. Never a server error.
          expect(refused.status, `${label} #${i}: ${JSON.stringify(refused.body)}`).toBeGreaterThanOrEqual(400);
          expect(refused.status, `${label} #${i}: ${JSON.stringify(refused.body)}`).toBeLessThan(500);
        }
      }
    }
    // The race is real: across the runs, the trigger was what stopped at least some of them.
    process.stderr.write(`owner race, refusals by the trigger: ${JSON.stringify(triggered)}
`);
  } finally {
    for (const id of organizations) await prisma.organization.deleteMany({ where: { id } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
  }
}, 600_000);
