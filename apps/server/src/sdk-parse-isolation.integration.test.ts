import { read } from '@logbird/clickhouse';
import { prisma } from '@logbird/database';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Logbird } from '../../../packages/sdk/src/index';
import { clickhouse } from './clickhouse';
import { type ImmutableFixture, immutableFixture } from './immutable-fixture';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });
let fixture: ImmutableFixture;
beforeEach(async () => {
  fixture = await immutableFixture('qa91-sdk');
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await fixture.cleanup();
  for (const table of ['events', 'event_ids', 'events_by_minute', 'entities', 'attribute_keys']) {
    expect(await read(clickhouse, `SELECT count() n FROM ${table} WHERE project_id={p:String}`, { p: fixture.project })).toEqual([{ n: 0 }]);
  }
  expect(await prisma.ingestReceipt.count({ where: { projectId: fixture.project } })).toBe(0);
});
it.each([5, 80])('drives the real in-process ingest app with %i poison events and never drops healthy input', async (badCount) => {
  // A fixed occurredAt keeps the SDK-prepared content identical across instances (it fills occurredAt with "now").
  const occurredAt = new Date(Date.now() - 60_000).toISOString();
  const batch = Array.from({ length: 1000 }, (_, i) => ({
    id: `sdk-${i}`,
    action: 'qa91.sdk',
    occurredAt,
    ...(i < badCount ? { metadata: { '\ud800': 'bad' } } : {}),
  }));
  const responses: { status: number; body: unknown }[] = [];
  const bodies: string[] = [];
  vi.stubGlobal('fetch', async (_url: unknown, init: RequestInit) => {
    bodies.push(String(init.body));
    const result = await fixture.post(JSON.parse(String(init.body)));
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
    maxRetries: 1,
    flushIntervalMs: 60_000,
    onDrop: (e) => dropped.push(e.id!),
    onError: (e) => errors.push(e),
  });
  for (const e of batch) sdk.track(e);
  if (badCount === 5) {
    await sdk.flush();
    expect(responses.map((r) => r.status)).toEqual([202]);
    expect(dropped).toEqual(batch.slice(0, 5).map((e) => e.id));
    expect(sdk.queueSize).toBe(0);
    expect(await fixture.count()).toBe(995);
    await sdk.shutdown();
  } else {
    await expect(sdk.flush()).rejects.toThrow('Logbird HTTP 503');
    await vi.waitFor(() => expect(errors.some((e) => e.message === 'Logbird HTTP 503')).toBe(true));
    expect(responses.map((r) => r.status)).toEqual([503, 503]);
    expect(bodies[0]).toBe(bodies[1]);
    const first = responses[0]!.body as { error: { details: { rejected: { index: number }[]; ids: string[] } } };
    expect(dropped).toEqual(first.error.details.rejected.map((r) => batch[r.index]!.id));
    expect(dropped.length).toBeGreaterThan(0);
    expect(dropped.length).toBeLessThanOrEqual(65);
    expect(sdk.queueSize).toBe(1000 - dropped.length);
    expect(await fixture.count()).toBe(10);
    expect(first.error.details.ids).toEqual(seeded.map((e) => e.id));
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
