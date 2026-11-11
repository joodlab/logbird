import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({ find: vi.fn(), claim: vi.fn(), confirm: vi.fn(), release: vi.fn(), insert: vi.fn(), lookup: vi.fn() }));
vi.mock('@logbird/database', () => ({
  findIngestReceipts: fake.find,
  claimIngestReceipts: fake.claim,
  confirmIngestReceipts: fake.confirm,
  expireIngestReceipts: vi.fn(),
  takeOverIngestReceipts: vi.fn(),
  INGEST_RECEIPT_WINDOW_MS: 600_000,
  prisma: { ingestReceipt: { deleteMany: fake.release } },
}));
vi.mock('@logbird/clickhouse', () => ({
  AmbiguousInsertError: class extends Error {},
  ASYNC_INSERT_FLUSH_BOUND_MS: 30_000,
  INGEST_CLAIM_LEASE_MS: 60_000,
  CLICKHOUSE_PARSE_ERROR_CODES: new Set(),
  eventFingerprint: () => 'v1:qa',
  retryFingerprint: () => 'v1:qa',
  existingEventIdentities: fake.lookup,
  insertEvents: fake.insert,
  normalizeEvent: vi.fn(),
  resolveTimestamp: vi.fn(),
}));
vi.mock('@logbird/worker/ingest-recovery', () => ({ ingestRecoveryRetryAfter: async () => 1 }));
vi.mock('./clickhouse', () => ({ clickhouse: {} }));

import { ApiError } from './errors';
import { type IngestCandidate, insertImmutableEvents } from './immutable-ingest';
import { ingestReceiptFailureResponse } from './ingest-receipt-errors';

const now = new Date('2026-11-11T00:00:00.000Z');
const receipt = { eventId: 'qa-event', fingerprint: 'v1:qa', receivedAt: now, eventAt: now, claimedAt: now, confirmedAt: null };
const candidates: IngestCandidate[] = [
  {
    index: 3,
    input: { action: 'qa.receipt' },
    row: { event_id: 'qa-event', received_at: now.toISOString(), timestamp: now.toISOString() } as IngestCandidate['row'],
  },
];
const conflict = () => Object.assign(new Error('receipt CAS lost'), { code: 'LOGBIRD_INGEST_RECEIPT_CONFLICT' });

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(now);
  fake.find.mockResolvedValue([]);
  fake.claim.mockResolvedValue([receipt]);
  fake.lookup.mockResolvedValue(new Map());
  fake.confirm.mockImplementation(async (_project, values: unknown[]) => {
    if (values.length) throw conflict();
  });
});
afterEach(() => vi.useRealTimers());

it('keeps acknowledged claims and reports the usual pending indices and Retry-After', async () => {
  const error = await insertImmutableEvents('qa-project', 'qa-org', candidates).catch((error: unknown) => error);
  expect(error).toBeInstanceOf(ApiError);
  expect(error).toMatchObject({
    status: 503,
    code: 'ingest_pending',
    retryAfter: 90,
    details: { accepted: 0, ids: [], indices: [3], eventIds: ['qa-event'] },
  });
  expect(fake.insert).toHaveBeenCalledTimes(1);
  expect(fake.release).not.toHaveBeenCalled();
});

it('releases pre-insert claims after a paused recheck conflict and exposes a retryable mapping', async () => {
  fake.lookup
    .mockImplementationOnce(async () => {
      vi.setSystemTime(now.getTime() + 600_000);
      return new Map();
    })
    .mockResolvedValueOnce(new Map([['qa-event', receipt]]));
  const error = await insertImmutableEvents('qa-project', 'qa-org', candidates).catch((error: unknown) => error);
  expect(ingestReceiptFailureResponse(error)).toMatchObject({ status: 503, retryAfter: '1', body: { error: { code: 'ingest_unavailable' } } });
  expect(fake.release).toHaveBeenCalledWith({ where: { projectId: 'qa-project', eventId: { in: ['qa-event'] }, confirmedAt: null } });
  expect(fake.insert).not.toHaveBeenCalled();
});
