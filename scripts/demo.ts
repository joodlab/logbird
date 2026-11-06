import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { createClickHouseClient, purgeProject } from '@logbird/clickhouse';
import { prisma, withProjectLock } from '@logbird/database';
import { Logbird } from '@logbird/sdk';
import { generateEvents } from '@logbird/seed';
import { generateApiKey } from '../apps/server/src/keys';
import { client, endpoint, login } from './http';

const { values } = parseArgs({
  options: {
    events: { type: 'string', default: '300000' },
    'ledger-events': { type: 'string', default: '5000' },
    sink: { type: 'string', default: 'api' },
  },
});
if (values.sink !== 'api') throw new Error('Demo supports --sink api only.');
const ch = createClickHouseClient();
try {
  const user = await prisma.user.upsert({
    where: { email: 'demo@logbird.local' },
    update: { name: 'Raed (demo)' },
    create: { id: randomUUID(), email: 'demo@logbird.local', name: 'Raed (demo)', emailVerified: true },
  });
  const org = await prisma.organization.upsert({
    where: { slug: 'acme' },
    update: { name: 'Acme' },
    create: { id: randomUUID(), name: 'Acme', slug: 'acme', createdAt: new Date() },
  });
  const member = await prisma.member.findFirst({ where: { organizationId: org.id, userId: user.id } });
  if (member) await prisma.member.update({ where: { id: member.id }, data: { role: 'owner' } });
  else await prisma.member.create({ data: { id: randomUUID(), organizationId: org.id, userId: user.id, role: 'owner', createdAt: new Date() } });
  const cookie = await login(user.email),
    api = client(cookie);
  await api('/api/auth/organization/set-active', 'POST', { organizationId: org.id });
  for (const [name, slug, retentionDays, count] of [
    ['StayDesk', 'staydesk', 90, Number(values.events)],
    ['Ledger demo', 'ledger-demo', 30, Number(values['ledger-events'])],
  ] as const) {
    if (!Number.isInteger(count) || count < 1) throw new Error('Event counts must be positive integers.');
    const project = await prisma.project.upsert({
      where: { organizationId_slug: { organizationId: org.id, slug } },
      update: { name, retentionDays },
      create: { organizationId: org.id, name, slug, retentionDays },
    });
    await withProjectLock(project.id, async () => purgeProject(ch, project.id));
    const material = generateApiKey('ingest');
    await prisma.apiKey.create({
      data: { projectId: project.id, name: 'Demo run', kind: 'ingest', hash: material.hash, prefix: material.prefix, createdById: user.id },
    });
    const errors: Error[] = [];
    const sdk = new Logbird({ apiKey: material.secret, endpoint, batchSize: 1000, onError: (e) => errors.push(e) });
    const start = performance.now();
    let sent = 0;
    for (const event of generateEvents({ events: count, days: Math.min(60, retentionDays - 1), project: name })) {
      sdk.track(event);
      if (++sent % 1000 === 0) await sdk.flush();
    }
    await sdk.shutdown();
    if (errors.length) throw new Error(`Demo ingestion failed: ${errors[0]?.message}`);
    const stored = await (
      await ch.query({ query: 'SELECT count() n FROM events WHERE project_id={p:String}', query_params: { p: project.id }, format: 'JSONEachRow' })
    ).json<{ n: string }>();
    if (Number(stored[0]?.n) !== count) throw new Error('Demo stored count differs from generated count.');
    const seconds = (performance.now() - start) / 1000;
    console.log(JSON.stringify({ project: name, events: sent, seconds, eventsPerSecond: Math.round(sent / seconds) }));
    const from = new Date(Date.now() - retentionDays * 86_400_000).toISOString();
    for (const route of ['overview', 'events?q=action:hotel.*']) {
      const latencies: number[] = [];
      for (let i = 0; i < 5; i++) {
        const t = performance.now();
        await (await api(`/api/projects/${project.id}/${route}${route.includes('?') ? '&' : '?'}from=${from}`)).json();
        latencies.push(Math.round(performance.now() - t));
      }
      console.log(JSON.stringify({ project: name, route, milliseconds: latencies }));
    }
  }
  console.log('Login: demo@logbird.local - OTP is delivered to Mailpit http://127.0.0.1:8025');
} finally {
  await ch.close();
  await prisma.$disconnect();
}
