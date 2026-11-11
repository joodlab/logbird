import { insertEvents, read } from '@logbird/clickhouse';
import { prisma } from '@logbird/database';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Logbird } from '../../../packages/sdk/src/index';
import { clickhouse } from './clickhouse';
import { type ImmutableFixture, immutableFixture } from './immutable-fixture';
import { installIngestStorageFault } from './ingest-storage-fault-fixture';
import { LegacySdk011Fixture } from './legacy-sdk-011-fixture';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });
let fixture: ImmutableFixture;
beforeEach(async () => {
  fixture = await immutableFixture('qa91-sdk');
  installIngestStorageFault();
});

it.each([20, 80])('legacy SDK 0.1.1 and raw HTTP terminate immediately with %i leading storage faults in 1000 rows', async (badCount) => {
  const occurredAt = new Date(Date.now() - 60_000).toISOString();
  const batch = Array.from({ length: 1000 }, (_, index) => ({
    id: `legacy-${index}`,
    action: 'qa91.legacy',
    occurredAt,
    ...(index < badCount ? { metadata: { qa91StorageParseFault: true } } : {}),
  }));
  // The test-only adapter sends an invalid UInt16 to REAL ClickHouse, not a fabricated parser error.
  await expect(insertEvents(clickhouse, [fixture.row(batch[0])])).rejects.toMatchObject({
    code: expect.stringMatching(/^(25|27|53|72)$/),
    message: expect.stringContaining('WaitForAsyncInsert'),
  });
  const seeded = batch.slice(-10);
  expect((await fixture.post(seeded)).status).toBe(202);
  const raw = await fixture.post({ events: batch }); // No capability header.
  expect(raw.status).toBe(202);
  const result = await raw.json();
  expect(result.ids.toSorted()).toEqual(seeded.map((event) => event.id).toSorted());
  const proven = result.rejected.filter((rejection: { code: string }) => rejection.code === 'invalid_event');
  const unchecked = result.rejected.filter((rejection: { code: string }) => rejection.code === 'unverified_after_parse_failure');
  expect(proven.length).toBeGreaterThan(0);
  expect(proven.length).toBeLessThan(badCount);
  expect(
    proven.every((rejection: { index: number; reason: string }) => rejection.index < badCount && rejection.reason.startsWith('invalid_event:')),
  ).toBe(true);
  expect(unchecked.length).toBeGreaterThan(0);
  expect(unchecked.every((rejection: { reason: string }) => rejection.reason.startsWith('unverified_after_parse_failure:'))).toBe(true);
  expect(new Set(result.rejected.map((rejection: { index: number }) => rejection.index)).size).toBe(1000 - seeded.length);
  expect(result.rejected).toHaveLength(proven.length + unchecked.length);
  const statuses: number[] = [],
    dropped: string[] = [];
  vi.stubGlobal('fetch', async (_url: unknown, init: RequestInit) => {
    expect(new Headers(init.headers).get('Logbird-Retry')).toBeNull();
    const response = await fixture.post(JSON.parse(String(init.body)));
    statuses.push(response.status);
    return response;
  });
  const legacy = new LegacySdk011Fixture({ apiKey: 'fictional', endpoint: 'http://in-process.invalid', onDrop: (event) => dropped.push(event.id!) });
  for (const event of batch) legacy.track(event);
  await legacy.flush();
  expect(statuses).toEqual([202]); // No 503 retry loop; the queue is no longer wedged.
  expect(legacy.queueSize).toBe(0);
  expect(new Set(dropped)).toEqual(new Set(result.rejected.map((rejection: { index: number }) => batch[rejection.index]!.id)));
  expect(dropped).toHaveLength(result.rejected.length);
  for (const table of ['events', 'event_ids']) {
    expect(
      await read(clickhouse, `SELECT event_id id,count() n FROM ${table} WHERE project_id={p:String} GROUP BY event_id ORDER BY event_id`, {
        p: fixture.project,
      }),
    ).toEqual(seeded.map((event) => ({ id: event.id, n: 1 })).sort((a, b) => a.id.localeCompare(b.id)));
  }
  expect(await read(clickhouse, 'SELECT sum(events) n FROM events_by_minute WHERE project_id={p:String}', { p: fixture.project })).toEqual([
    { n: seeded.length },
  ]);
  legacy.track({ id: 'legacy-later', action: 'qa91.after' });
  await legacy.flush();
  expect(statuses).toEqual([202, 202]);
  expect(await fixture.count()).toBe(seeded.length + 1);
});
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await fixture.cleanup();
  for (const table of ['events', 'event_ids', 'events_by_minute', 'entities', 'attribute_keys']) {
    expect(await read(clickhouse, `SELECT count() n FROM ${table} WHERE project_id={p:String}`, { p: fixture.project })).toEqual([{ n: 0 }]);
  }
  expect(await prisma.ingestReceipt.count({ where: { projectId: fixture.project } })).toBe(0);
});
it.each([3, 80])('drives the real in-process ingest app with %i poison events and never drops healthy input', async (badCount) => {
  // A fixed occurredAt keeps the SDK-prepared content identical across instances (it fills occurredAt with "now").
  const occurredAt = new Date(Date.now() - 60_000).toISOString();
  const batch = Array.from({ length: 1000 }, (_, i) => ({
    id: `sdk-${i}`,
    action: 'qa91.sdk',
    occurredAt,
    ...(i < badCount ? { metadata: { qa91StorageParseFault: true } } : {}),
  }));
  const responses: { status: number; body: unknown }[] = [];
  const bodies: string[] = [];
  vi.stubGlobal('fetch', async (_url: unknown, init: RequestInit) => {
    bodies.push(String(init.body));
    expect(new Headers(init.headers).get('Logbird-Retry')).toBe('subset');
    const result = await fixture.post(JSON.parse(String(init.body)), 0, { 'Logbird-Retry': 'subset' });
    responses.push({ status: result.status, body: await result.clone().json() });
    return result;
  });
  // Confirm some siblings first through the SDK itself (same prepared content), proving retries preserve and report
  // existing healthy writes instead of treating them as conflicts.
  const seeded = batch.slice(-10);
  const seeder = new Logbird({ apiKey: 'fictional', endpoint: 'http://in-process.invalid', batchSize: 1000, flushIntervalMs: 60_000 });
  for (const e of seeded) seeder.track(e);
  await seeder.shutdown();
  expect(responses.map((r) => r.status)).toEqual([202]);
  responses.length = 0;
  bodies.length = 0;
  const dropped: string[] = [],
    errors: Error[] = [];
  const sdk = new Logbird({
    apiKey: 'fictional',
    endpoint: 'http://in-process.invalid',
    batchSize: 1000,
    flushIntervalMs: 60_000,
    onDrop: (e) => dropped.push(e.id!),
    onError: (e) => errors.push(e),
  });
  for (const e of batch) sdk.track(e);
  if (badCount === 3) {
    await sdk.flush();
    expect(responses.map((r) => r.status)).toEqual([202]);
    expect(dropped).toEqual(batch.slice(0, badCount).map((e) => e.id));
    expect(sdk.queueSize).toBe(0);
    expect(await fixture.count()).toBe(1000 - badCount);
    await sdk.shutdown();
  } else {
    await sdk.flush();
    expect(responses.length).toBeGreaterThan(1);
    expect(responses.length).toBeLessThanOrEqual(badCount + 1);
    expect(responses.at(-1)!.status).toBe(202);
    const expectedDropped: string[] = [];
    for (let attempt = 0; attempt < responses.length - 1; attempt++) {
      expect(responses[attempt]!.status).toBe(503);
      const wire = responses[attempt]!.body as {
        error: { code: string; details: { rejected: { index: number }[]; ids: string[]; indices: number[] } };
      };
      expect(wire.error.code).toBe('ingest_pending');
      const sent = JSON.parse(bodies[attempt]!).events as typeof batch;
      const next = JSON.parse(bodies[attempt + 1]!).events as typeof batch;
      expectedDropped.push(...wire.error.details.rejected.map((r) => sent[r.index]!.id));
      expect(wire.error.details.rejected.length).toBeGreaterThan(0);
      expect(next).toEqual(wire.error.details.indices.map((index) => sent[index]));
      expect(next.length).toBeLessThan(sent.length);
      // These leading poison rows cannot hide forever: each response settles more original events.
      expect(new Set(expectedDropped).size).toBe(expectedDropped.length);
    }
    const final = responses.at(-1)!.body as { rejected: { index: number }[] };
    const finalSent = JSON.parse(bodies.at(-1)!).events as typeof batch;
    expectedDropped.push(...final.rejected.map((r) => finalSent[r.index]!.id));
    expect(dropped).toEqual(expectedDropped);
    expect(dropped).toHaveLength(badCount);
    expect(sdk.queueSize).toBe(0);
    expect(await fixture.count()).toBe(1000 - badCount);
    expect(errors.every((error) => error.message.includes('events rejected by Logbird:'))).toBe(true);
    await sdk.shutdown();
  }
  expect(dropped.every((id) => Number(id.slice(4)) < badCount)).toBe(true);
  expect(new Set(dropped).size).toBe(dropped.length);
  for (const table of ['events', 'event_ids']) {
    expect(
      await read(clickhouse, `SELECT count() n FROM ${table} WHERE project_id={p:String} AND event_id IN {ids:Array(String)}`, {
        p: fixture.project,
        ids: seeded.map((e) => e.id),
      }),
    ).toEqual([{ n: 10 }]);
  }
});
