import { read } from '@logbird/clickhouse';
import { prisma } from '@logbird/database';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { clickhouse } from './clickhouse';
import { type ImmutableFixture, immutableFixture } from './immutable-fixture';

let f: ImmutableFixture;
beforeEach(async () => {
  f = await immutableFixture('qa-oversized');
});
afterEach(async () => {
  await f.cleanup();
});

it('rejects only the event over 256 KB and stores its healthy siblings', async () => {
  const response = await f.post([
    { id: 'before-huge', action: 'qa.ok' },
    { id: 'huge', action: 'qa.huge', metadata: { blob: 'x'.repeat(300 * 1024) } },
    { id: 'after-huge', action: 'qa.ok' },
  ]);
  expect(response.status).toBe(202);
  const body = await response.json();
  expect(body.accepted).toBe(2);
  expect(body.ids).toEqual(['before-huge', 'after-huge']);
  expect(body.rejected).toEqual([{ index: 1, code: 'invalid_event', reason: 'invalid_event: event exceeds 256 KB' }]);
  expect(await f.count()).toBe(2);
});

it('accepts an event of exactly 256 KB of serialized JSON', async () => {
  const shell = JSON.stringify({ id: 'edge', action: 'qa.edge', metadata: { blob: '' } });
  const event = { id: 'edge', action: 'qa.edge', metadata: { blob: 'x'.repeat(256 * 1024 - Buffer.byteLength(shell)) } };
  expect(Buffer.byteLength(JSON.stringify(event))).toBe(256 * 1024);
  const response = await f.post(event);
  expect(response.status).toBe(202);
  expect((await response.json()).accepted).toBe(1);
});

it('keeps the 1000-event request limit whole-request', async () => {
  const response = await f.post(Array.from({ length: 1001 }, (_, i) => ({ id: `e${i}`, action: 'qa.many' })));
  expect(response.status).toBe(413);
  expect(await response.json()).toEqual({ error: { code: 'payload_too_large', message: 'Maximum 1000 events per request.' } });
  expect(await f.count()).toBe(0);
});

it('stores a test event for a user with a large profile image, without copying profile fields', async () => {
  await f.authorize();
  const member = await prisma.member.findFirstOrThrow({ where: { organizationId: f.org } });
  await prisma.user.update({ where: { id: member.userId }, data: { image: `data:image/png;base64,${'A'.repeat(300 * 1024)}` } });
  const response = await f.management(`/api/projects/${f.project}/test-event`, 'POST', {});
  expect(response.status).toBe(202);
  expect((await response.json()).accepted).toBe(1);
  const [row] = await read<{ payload: string }>(clickhouse, 'SELECT payload FROM events WHERE project_id={p:String}', { p: f.project });
  expect(Object.keys(JSON.parse(row?.payload ?? '{}').actor).sort()).toEqual(['email', 'id', 'name', 'type']);
});
