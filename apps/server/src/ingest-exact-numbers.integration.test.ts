import { exportEvents, insertEvents, searchEvents } from '@logbird/clickhouse';
import { prisma } from '@logbird/database';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { clickhouse } from './clickhouse';
import { type ImmutableFixture, immutableFixture } from './immutable-fixture';
import { generateApiKey } from './keys';

let f: ImmutableFixture;
let readSecret = '';
beforeEach(async () => {
  f = await immutableFixture('qa-exact-numbers');
  const key = generateApiKey('read');
  await prisma.apiKey.create({ data: { projectId: f.project, name: 'QA read', kind: 'read', hash: key.hash, prefix: key.prefix } });
  readSecret = key.secret;
});
afterEach(async () => {
  await f.cleanup();
});

const occurredAt = new Date(Date.now() - 60_000).toISOString();
const body = `{"id":"exact-1","action":"order.paid","occurredAt":"${occurredAt}","actor":{"type":"user","id":42},"targets":[{"type":"order","id":9007199254740993}],"metadata":{"snowflake":1234567890123456789,"rate":0.12345678901234567890123,"plain":19.90},"changes":[{"field":"balance","before":12345678901234567891,"after":0.1}]}`;
const replica = () => {
  const app = f.replicas[0];
  if (!app) throw new Error('fixture replica missing');
  return app;
};
const rawPost = (text: string) =>
  replica().request('/v1/events', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${f.key.secret}` },
    body: text,
  });
const range = { from: new Date(Date.now() - 3_600_000).toISOString(), to: new Date(Date.now() + 60_000).toISOString() };

it('keeps exact digits from ingest through storage, the read API, search and the evidence export', async () => {
  const first = await rawPost(body);
  expect(first.status).toBe(202);
  expect(await first.json()).toMatchObject({ accepted: 1, ids: ['exact-1'], rejected: [] });

  const detail = await replica().request('/v1/events/exact-1', { headers: { Authorization: `Bearer ${readSecret}` } });
  expect(detail.status).toBe(200);
  const text = await detail.text();
  // JSON numbers with the exact digits, not strings.
  expect(text).toContain('"snowflake":1234567890123456789');
  expect(text).toContain('"rate":0.12345678901234567890123');
  expect(text).toContain('"before":12345678901234567891');
  expect(text).toContain('"id":9007199254740993');
  expect(text).toContain('"plain":19.9');
  expect(text).toContain('"metadata.snowflake":"1234567890123456789"');
  expect(text).toContain('"before":"12345678901234567891"');

  for (const q of [
    'metadata.snowflake:1234567890123456789',
    'actor:42',
    'target:9007199254740993 target.type:order',
    'attr.metadata.rate:0.12345678901234567890123',
  ]) {
    const found = await searchEvents(clickhouse, f.project, { ...range, q, limit: 10, order: 'desc' });
    expect(found.data.map((e) => e.id)).toEqual(['exact-1']);
  }
  expect(
    (await searchEvents(clickhouse, f.project, { ...range, q: 'metadata.snowflake:1234567890123456800', limit: 10, order: 'desc' })).data,
  ).toEqual([]);

  const lines: string[] = [];
  for await (const chunk of exportEvents(clickhouse, f.project, { ...range, format: 'jsonl-evidence' })) lines.push(chunk);
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain('"payload":{"id":"exact-1"');
  expect(lines[0]).toContain('"snowflake":1234567890123456789');
});

it('treats an identical raw retry as the same event and the rounded number as different content', async () => {
  expect((await rawPost(body)).status).toBe(202);
  const retry = await rawPost(body);
  expect(await retry.json()).toMatchObject({ accepted: 1, ids: ['exact-1'], rejected: [] });
  const rounded = await rawPost(body.replace('1234567890123456789', '1234567890123456800'));
  const roundedBody = await rounded.json();
  expect(roundedBody.accepted).toBe(0);
  expect(roundedBody.rejected[0].code).toBe('duplicate_id_conflict');
  expect(await f.count()).toBe(1);
});

it('answers duplicate_id_conflict for a retry of an event stored before exact numbers (rounded payload)', async () => {
  await insertEvents(clickhouse, [f.row(JSON.parse(body))]);
  const retry = await rawPost(body);
  expect(retry.status).toBe(202);
  const retryBody = await retry.json();
  expect(retryBody.accepted).toBe(0);
  expect(retryBody.rejected[0].code).toBe('duplicate_id_conflict');
  expect(await f.count()).toBe(1);
});

it('never accepts a different number that rounds to the stored one, in either order', async () => {
  const at = new Date(Date.now() - 30_000).toISOString();
  const event = (n: string, id: string) => `{"id":"${id}","action":"qa.round","occurredAt":"${at}","metadata":{"n":${n}}}`;
  for (const [first, second, id] of [
    ['9007199254740992', '9007199254740993', 'round-up'],
    ['9007199254740993', '9007199254740992', 'round-down'],
  ] as const) {
    expect((await rawPost(event(first, id))).status).toBe(202);
    const conflict = await (await rawPost(event(second, id))).json();
    expect(conflict.accepted).toBe(0);
    expect(conflict.rejected[0].code).toBe('duplicate_id_conflict');
  }
  // Two events in one batch with the same id and nearby 64-bit numbers are also a conflict.
  const batch = await (await rawPost(`[${event('9007199254740994', 'same-batch')},${event('9007199254740995', 'same-batch')}]`)).json();
  expect(batch.accepted).toBe(1);
  expect(batch.rejected[0].code).toBe('duplicate_id_conflict');
  expect(await f.count()).toBe(3);
});

it('keeps a shallow event exact beside a deeply nested wrapper property, so a standalone retry matches', async () => {
  const event = `{"id":"wrapped","action":"qa.wrapped","occurredAt":"${occurredAt}","metadata":{"snowflake":9007199254740993}}`;
  const wrapped = await rawPost(`{"events":[${event}],"ignored":${'['.repeat(20_000)}1${']'.repeat(20_000)}}`);
  expect(wrapped.status).toBe(202);
  expect(await wrapped.json()).toMatchObject({ accepted: 1, ids: ['wrapped'], rejected: [] });
  const retry = await rawPost(event);
  expect(await retry.json()).toMatchObject({ accepted: 1, ids: ['wrapped'], rejected: [] });
  expect(await f.count()).toBe(1);
});
