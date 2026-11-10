import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { eventFingerprint, normalizeEvent, read } from '@logbird/clickhouse';
import { prisma, withProjectLock } from '@logbird/database';
import { Hono } from 'hono';
import { app } from './app';
import { clickhouse, purgeProjectEvents } from './clickhouse';
import { generateApiKey } from './keys';

export async function immutableFixture(prefix = 'qa-immutable') {
  const org = randomUUID(),
    project = `${prefix}-${randomUUID()}`;
  const key = generateApiKey('ingest');
  let userId: string | undefined;
  let cookie = '';
  await prisma.organization.create({ data: { id: org, name: 'QA Immutable', slug: org, createdAt: new Date() } });
  await prisma.project.create({ data: { id: project, organizationId: org, name: 'QA Immutable', slug: project } });
  if (process.env.INGEST_FIXTURE_LEDGER)
    appendFileSync(
      process.env.INGEST_FIXTURE_LEDGER,
      `${JSON.stringify({ projectId: project, organizationId: org, prefix: process.env.BULLMQ_PREFIX })}\n`,
    );
  await prisma.apiKey.create({ data: { projectId: project, name: 'QA key', kind: 'ingest', hash: key.hash, prefix: key.prefix } });
  const first = new Hono().route('/', app);
  const replicas = [first, new Hono().route('/', app)];
  const post = (input: unknown, replica = 0) =>
    (replicas[replica] ?? first).request('/v1/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key.secret}` },
      body: JSON.stringify(input),
    });
  const row = (input: unknown, receivedAt = new Date()) => {
    const normalized = normalizeEvent(input, { projectId: project, receivedAt });
    if (!normalized.ok) throw new Error(normalized.reason);
    return normalized.row;
  };
  const pending = async (input: unknown, options: { expired?: boolean; legacy?: string; receivedAt?: Date } = {}) => {
    const normalized = row(input, options.receivedAt);
    await prisma.ingestReceipt.create({
      data: {
        projectId: project,
        organizationId: org,
        eventId: normalized.event_id,
        fingerprint: options.legacy ?? eventFingerprint(normalized),
        receivedAt: new Date(normalized.received_at),
        eventAt: new Date(normalized.timestamp),
        claimedAt: options.expired ? new Date(Date.now() - 80_000) : new Date(),
      },
    });
    return normalized;
  };
  const count = async () =>
    Number((await read<{ n: number }>(clickhouse, 'SELECT count() n FROM events WHERE project_id={p:String}', { p: project }))[0]?.n ?? 0);
  const management = (path: string, method = 'GET', body?: unknown) =>
    app.request(path, {
      method,
      headers: { cookie, 'Content-Type': 'application/json', Origin: process.env.APP_URL ?? 'http://localhost:4600' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const authorize = async () => {
    const email = `qa-fix-ingest-${randomUUID()}@example.test`;
    const sent = await management('/api/auth/email-otp/send-verification-otp', 'POST', { email, type: 'sign-in' });
    if (sent.status !== 200) throw new Error('Fixture OTP request failed');
    const mailbox = await (await fetch('http://127.0.0.1:8025/api/v1/messages?limit=100')).json();
    const message = mailbox.messages.find((m: { To: { Address: string }[] }) => m.To.some((t) => t.Address === email));
    const content = await (await fetch(`http://127.0.0.1:8025/api/v1/message/${message?.ID}`)).json();
    const login = await management('/api/auth/sign-in/email-otp', 'POST', { email, otp: content.Text.match(/\b\d{6}\b/)?.[0] });
    if (login.status !== 200) throw new Error('Fixture sign-in failed');
    userId = (await login.json()).user.id;
    cookie = login.headers
      .getSetCookie()
      .map((v) => v.split(';')[0])
      .join('; ');
    await prisma.member.create({ data: { id: randomUUID(), organizationId: org, userId: userId as string, role: 'owner', createdAt: new Date() } });
    const active = await management('/api/auth/organization/set-active', 'POST', { organizationId: org });
    if (active.status !== 200) throw new Error('Fixture active workspace failed');
  };
  const cleanup = async () => {
    await withProjectLock(project, () => purgeProjectEvents(project));
    if (userId) await withProjectLock(`ws:${org}`, () => purgeProjectEvents(`ws:${org}`));
    await prisma.organization.deleteMany({ where: { id: org } });
    if (userId) await prisma.user.deleteMany({ where: { id: userId } });
  };
  return { org, project, key, replicas, post, row, pending, count, cleanup, authorize, management };
}
export type ImmutableFixture = Awaited<ReturnType<typeof immutableFixture>>;
