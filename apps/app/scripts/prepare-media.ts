// Additive, isolated fixtures only. Never purge shared demo projects.
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { prisma } from '@logbird/database';
import { Logbird } from '@logbird/sdk';
import { generateEvents } from '@logbird/seed';
import { client, endpoint, login } from '../../../scripts/http';
import { generateApiKey } from '../../server/src/keys';

const run = Date.now().toString(36);
const email = `demo+${run}@example.com`;
try {
  const user = await prisma.user.create({ data: { id: randomUUID(), email, name: 'Demo operator', emailVerified: true } });
  const org = await prisma.organization.create({ data: { id: randomUUID(), name: 'Acme', slug: `acme-media-${run}`, createdAt: new Date() } });
  await prisma.member.create({ data: { id: randomUUID(), organizationId: org.id, userId: user.id, role: 'owner', createdAt: new Date() } });
  const api = client(await login(email));
  await api('/api/auth/organization/set-active', 'POST', { organizationId: org.id });
  let fixture: { email: string; projectId: string; ingestKey: string } | undefined;
  for (const [name, slug, count] of [
    ['StayDesk', 'staydesk', 18_000],
    ['Ledger demo', 'ledger-demo', 1000],
  ] as const) {
    const project = await prisma.project.create({ data: { organizationId: org.id, name, slug, retentionDays: 90, setupDismissedAt: new Date() } });
    const key = generateApiKey('ingest');
    await prisma.apiKey.create({
      data: { projectId: project.id, name: 'Fictional media fixture', kind: 'ingest', hash: key.hash, prefix: key.prefix, createdById: user.id },
    });
    const sdk = new Logbird({ apiKey: key.secret, endpoint, batchSize: 1000 });
    let sent = 0;
    for (const event of generateEvents({ events: count, days: 7, project: name, profile: 'staydesk', spread: true, now: new Date() })) {
      sdk.track(event);
      if (++sent % 1000 === 0) await sdk.flush();
    }
    await sdk.shutdown();
    if (slug === 'staydesk') fixture = { email, projectId: project.id, ingestKey: key.secret };
  }
  await mkdir('.tmp', { recursive: true });
  await writeFile('.tmp/media-fixture.json', JSON.stringify(fixture), { mode: 0o600 });
  console.log('Created isolated fictional Acme / StayDesk and Ledger demo fixtures. Private capture state is in .tmp.');
} finally {
  await prisma.$disconnect();
}
