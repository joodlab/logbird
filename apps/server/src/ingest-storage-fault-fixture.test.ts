import { Readable } from 'node:stream';
import { type ClickHouseClient, insertEvents, normalizeEvent } from '@logbird/clickhouse';
import { afterEach, expect, it, vi } from 'vitest';
import { installIngestStorageFault } from './ingest-storage-fault-fixture';

afterEach(() => vi.restoreAllMocks());

it('injects the storage fault only into designated serialized rows through the real insert entrypoint', async () => {
  const rows = [false, true].map((poison, index) => {
    const result = normalizeEvent(
      { id: `fault-${index}`, action: 'qa91.fixture', ...(poison ? { metadata: { qa91StorageParseFault: true } } : {}) },
      { projectId: 'qa91-unit', receivedAt: new Date() },
    );
    if (!result.ok) throw new Error(result.reason);
    return result.row;
  });
  const original = structuredClone(rows);
  const bodies: string[] = [];
  // Exercise the production serializer and lazy stream without opening a socket.
  const client = {
    exec: vi.fn(async ({ values }: { values: AsyncIterable<Buffer> }) => {
      const chunks: Buffer[] = [];
      for await (const chunk of values) chunks.push(Buffer.from(chunk));
      bodies.push(Buffer.concat(chunks).toString());
      return { stream: Readable.from([]) };
    }),
  } as unknown as ClickHouseClient;
  installIngestStorageFault();
  await insertEvents(client, rows);
  await insertEvents(client, rows, undefined, rows.map((row) => `${JSON.stringify(row)}\n`).join(''));
  expect(bodies[0]).toBe(bodies[1]); // Both direct and cached-body INSERTs use the same storage fault.
  const sent = bodies[0]?.trim().split('\n');
  expect(sent?.map((line) => JSON.parse(line))).toEqual([original[0], { ...original[1], job_attempt: 'not-a-number' }]);
  expect(rows).toEqual(original); // Payload, planned rows and immutable identity are never changed by the fixture.
});
