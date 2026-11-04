import { randomUUID } from 'node:crypto';
import { prisma } from '@trailmark/database';
import { Hono } from 'hono';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { ApiError } from '../errors';
import { generateApiKey } from '../keys';
import type { AppEnv } from '../types';
import { requireApiKey } from './require-api-key';

const organizationId = randomUUID();
let projectId: string;
const ingest = generateApiKey('ingest');
const read = generateApiKey('read');
const app = new Hono<AppEnv>()
  .onError((error, c) => c.json({ error: error.message }, error instanceof ApiError ? error.status : 500))
  .get('/ingest', requireApiKey('ingest'), (c) => c.json({ projectId: c.get('project').id }))
  .get('/read', requireApiKey('read'), (c) => c.json({ projectId: c.get('project').id }));
const request = (path: string, secret?: string) => app.request(path, { headers: secret ? { Authorization: `Bearer ${secret}` } : {} });
beforeAll(async () => {
  await prisma.organization.create({ data: { id: organizationId, name: 'API key regression fixture', slug: organizationId, createdAt: new Date() } });
  const project = await prisma.project.create({ data: { organizationId, name: 'API key fixture', slug: 'keys' } });
  projectId = project.id;
  for (const [kind, material] of [
    ['ingest', ingest],
    ['read', read],
  ] as const)
    await prisma.apiKey.create({ data: { projectId, name: kind, kind, hash: material.hash, prefix: material.prefix } });
});
afterAll(async () => {
  await prisma.organization.delete({ where: { id: organizationId } });
  await prisma.$disconnect();
});
it('binds keys to projects, rejects wrong scopes and malformed or unknown secrets', async () => {
  expect((await request('/ingest')).status).toBe(401);
  expect((await request('/ingest', 'invalid')).status).toBe(401);
  expect((await request('/ingest', generateApiKey('ingest').secret)).status).toBe(401);
  expect((await request('/ingest', read.secret)).status).toBe(401);
  expect((await request('/read', ingest.secret)).status).toBe(401);
  expect(await (await request('/ingest', ingest.secret)).json()).toEqual({ projectId });
  expect((await request('/read', read.secret)).status).toBe(200);
});
it('atomically throttles lastUsedAt writes and rejects revoked keys', async () => {
  await prisma.apiKey.update({ where: { hash: read.hash }, data: { lastUsedAt: null } });
  await Promise.all(Array.from({ length: 8 }, () => request('/read', read.secret)));
  const first = await prisma.apiKey.findUniqueOrThrow({ where: { hash: read.hash } });
  expect(first.lastUsedAt).not.toBeNull();
  await request('/read', read.secret);
  expect((await prisma.apiKey.findUniqueOrThrow({ where: { hash: read.hash } })).lastUsedAt).toEqual(first.lastUsedAt);
  await prisma.apiKey.update({ where: { hash: read.hash }, data: { lastUsedAt: new Date(Date.now() - 120_000) } });
  await request('/read', read.secret);
  expect((await prisma.apiKey.findUniqueOrThrow({ where: { hash: read.hash } })).lastUsedAt?.getTime()).toBeGreaterThan(Date.now() - 60_000);
  await prisma.apiKey.update({ where: { hash: read.hash }, data: { revokedAt: new Date() } });
  expect((await request('/read', read.secret)).status).toBe(401);
});
