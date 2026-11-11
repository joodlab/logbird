import { AmbiguousInsertError, INGEST_CLAIM_LEASE_MS, insertEvents, normalizeEvent } from '@logbird/clickhouse';
import { claimIngestReceipts, prisma } from '@logbird/database';
import { ingestRecoveryRetryAfter } from '@logbird/worker/ingest-recovery';
import { afterEach, expect, it, vi } from 'vitest';
import { insertImmutableEvents } from './immutable-ingest';

// Every service boundary is mocked before the ingest module loads; no clients or sockets are created.
vi.mock('./clickhouse', () => ({ clickhouse: {} }));
vi.mock('@logbird/clickhouse', async (original) => ({
  ...(await original<typeof import('@logbird/clickhouse')>()),
  existingEventIdentities: vi.fn(async () => new Map()),
  insertEvents: vi.fn(),
}));
vi.mock('@logbird/database', () => ({
  INGEST_RECEIPT_WINDOW_MS: 300_000,
  findIngestReceipts: vi.fn(async () => []),
  claimIngestReceipts: vi.fn(),
  confirmIngestReceipts: vi.fn(),
  expireIngestReceipts: vi.fn(),
  takeOverIngestReceipts: vi.fn(async () => []),
  prisma: { ingestReceipt: { deleteMany: vi.fn() } },
}));
vi.mock('@logbird/worker/ingest-recovery', () => ({ ingestRecoveryRetryAfter: vi.fn(async () => 0) }));

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

it.each(['452', '60', '62', '81', '164', '497', '516', 'parse', 'mixed', 'held'])('composes retry timing for %s failures', async (failure) => {
  vi.useFakeTimers({ toFake: ['Date'] });
  const receivedAt = new Date();
  vi.mocked(claimIngestReceipts).mockImplementation(async (projectId, organizationId, values) =>
    values.map((value) => ({ ...value, projectId, organizationId, expiresAt: new Date(Date.now() + 300_000) })),
  );
  vi.mocked(insertEvents).mockImplementation(async (_client, rows) => {
    if (failure === 'held') throw new AmbiguousInsertError();
    if (failure === 'parse' || failure === 'mixed') {
      if (rows.length === 3) throw Object.assign(new Error('Cannot parse (at row 2): While executing WaitForAsyncInsert.'), { code: '25' });
      if (failure === 'mixed' && rows[0]?.event_id === 'row-0') throw new AmbiguousInsertError();
      // Leave the healthy suffix unresolved after the lease limit; held prefixes retain their claim timing.
      vi.setSystemTime(Date.now() + 21_000);
      return;
    }
    throw Object.assign(new Error('Definite configuration rejection'), { code: failure });
  });
  const candidates = Array.from({ length: 3 }, (_, index) => {
    const input = { id: `row-${index}`, action: 'qa91.unit' };
    const normalized = normalizeEvent(input, { projectId: 'qa91-unit', receivedAt });
    if (!normalized.ok) throw new Error(normalized.reason);
    return { index, input, row: normalized.row };
  });
  const pending = ['parse', 'mixed', 'held'].includes(failure);
  const held = failure === 'mixed' || failure === 'held';
  const error = await insertImmutableEvents('qa91-unit', 'qa91-org', candidates).catch((error: unknown) => error);
  expect(error).toMatchObject({
    status: 503,
    code: pending ? 'ingest_pending' : 'ingest_unavailable',
    retryAfter: held ? Math.ceil((INGEST_CLAIM_LEASE_MS + 10_000 - (failure === 'mixed' ? 21_000 : 0)) / 1000) : pending ? 1 : 5,
    details: { rejected: pending && failure !== 'held' ? [{ index: 1, code: 'invalid_event', reason: expect.any(String) }] : [] },
  });
  expect(ingestRecoveryRetryAfter).toHaveBeenCalledTimes(held ? 1 : 0);
  expect(prisma.ingestReceipt.deleteMany).toHaveBeenCalledTimes(failure === 'held' ? 0 : 1);
});
