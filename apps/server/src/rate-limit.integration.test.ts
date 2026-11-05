import { randomUUID } from 'node:crypto';
import { prisma } from '@trailmark/database';
import { Hono } from 'hono';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { env } from './env';
import { generateApiKey } from './keys';
import { requireApiKey } from './middlewares/require-api-key';
import { createPublicRateLimits, rateLimitStore } from './rate-limit';
import type { AppEnv } from './types';

const id = randomUUID();
const prefix = `${env.BULLMQ_PREFIX}:test:${id}`;
const limits = createPublicRateLimits({ prefix, ingestLimit: 2, readLimit: 2, peerLimit: 2, now: () => 61_000 });
const keys = [generateApiKey('ingest'), generateApiKey('ingest'), generateApiKey('read'), generateApiKey('read')] as const;
const app = new Hono<AppEnv>()
  .get('/v1/ingest', requireApiKey('ingest', limits), limits.authenticated('ingest'), (c) => c.json({ ok: true }))
  .get('/v1/read', requireApiKey('read', limits), limits.authenticated('read'), (c) => c.json({ ok: true }))
  .get('/v1/detail', requireApiKey('read', limits), limits.authenticated('read'), (c) => c.json({ ok: true }));
const request = (path: string, peer: string, secret?: string) =>
  app.request(
    `/v1/${path}`,
    {
      headers: secret ? { authorization: `Bearer ${secret}` } : {},
    },
    { incoming: { socket: { remoteAddress: peer } } },
  );
beforeAll(async () => {
  await prisma.organization.create({ data: { id, name: 'Fictional limiter fixture', slug: id, createdAt: new Date() } });
  for (let i = 0; i < 2; i++) {
    const project = await prisma.project.create({ data: { organizationId: id, name: 'Fictional project', slug: `fixture-${i}` } });
    for (const [kind, key] of [
      ['ingest', keys[i % 2 === 0 ? 0 : 1]],
      ['read', keys[i % 2 === 0 ? 2 : 3]],
    ] as const)
      await prisma.apiKey.create({ data: { projectId: project.id, name: 'fixture', kind, hash: key.hash, prefix: key.prefix } });
  }
});
afterAll(async () => {
  // Only this run's namespace, never shared limiter or queue keys.
  const owned = await rateLimitStore.keys(`${prefix}:rate:*`);
  if (owned.length) await rateLimitStore.del(...owned);
  await prisma.organization.delete({ where: { id } });
  await rateLimitStore.quit();
  await prisma.$disconnect();
});
it('shares project buckets across peers, isolates projects/kinds, and counts only failed auth', async () => {
  const first = await request('ingest', '192.0.2.1', keys[0].secret);
  expect(first.status).toBe(200);
  expect(first.headers.get('RateLimit-Limit')).toBe('2');
  expect(first.headers.get('RateLimit-Remaining')).toBe('1');
  expect(Number(first.headers.get('RateLimit-Reset'))).toBeGreaterThan(0);
  expect((await request('ingest', '192.0.2.2', keys[0].secret)).headers.get('RateLimit-Remaining')).toBe('0');
  expect((await request('ingest', '192.0.2.1', keys[0].secret)).status).toBe(429);
  expect((await request('ingest', '192.0.2.1', keys[1].secret)).status).toBe(200);
  expect((await request('read', '192.0.2.1', keys[2].secret)).status).toBe(200);
  expect((await request('detail', '192.0.2.2', keys[2].secret)).status).toBe(200);
  expect((await request('read', '192.0.2.1', keys[2].secret)).status).toBe(429);
  expect((await request('ingest', '192.0.2.3')).status).toBe(401);
  expect((await request('ingest', '192.0.2.3', generateApiKey('ingest').secret)).status).toBe(401);
  expect((await request('ingest', '192.0.2.3', 'malformed')).status).toBe(429);
  expect((await request('ingest', '192.0.2.3', generateApiKey('ingest').secret)).status).toBe(429);
  expect((await request('read', '192.0.2.3', keys[3].secret)).status).toBe(200);
  await prisma.apiKey.update({ where: { hash: keys[3].hash }, data: { revokedAt: new Date() } });
  expect((await request('read', '192.0.2.3', keys[3].secret)).status).toBe(429);
  expect((await request('ingest', '192.0.2.3', keys[3].secret)).status).toBe(429);
});
