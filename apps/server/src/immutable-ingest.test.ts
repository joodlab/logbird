import { AmbiguousInsertError, eventFingerprint, INGEST_CLAIM_LEASE_MS, insertEvents, normalizeEvent } from '@logbird/clickhouse';
import { claimIngestReceipts, findIngestReceipts, prisma } from '@logbird/database';
import { ingestRecoveryRetryAfter } from '@logbird/worker/ingest-recovery';
import { afterEach, expect, it, vi } from 'vitest';
import { insertImmutableEvents, UNVERIFIED_PARSE_REJECTION, uncheckedIngestPolicy } from './immutable-ingest';
import * as isolation from './ingest-parse-isolation';

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
  vi.restoreAllMocks();
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
      if (rows[0]?.event_id === 'row-1') throw Object.assign(new Error('Cannot parse: While executing WaitForAsyncInsert.'), { code: '25' });
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
  const error = await insertImmutableEvents('qa91-unit', 'qa91-org', candidates, true).catch((error: unknown) => error);
  expect(error).toMatchObject({
    status: 503,
    code: pending ? 'ingest_pending' : 'ingest_unavailable',
    retryAfter: held ? Math.ceil((INGEST_CLAIM_LEASE_MS + 10_000 - (failure === 'mixed' ? 21_000 : 0)) / 1000) : pending ? 1 : 5,
    details: { rejected: pending && failure !== 'held' ? [{ index: 1, code: 'invalid_event', reason: expect.any(String) }] : [] },
  });
  expect(ingestRecoveryRetryAfter).toHaveBeenCalledTimes(held ? 1 : 0);
  expect(prisma.ingestReceipt.deleteMany).toHaveBeenCalledTimes(failure === 'held' ? 0 : 1);
});

function candidates() {
  return ['written', 'bad', 'unchecked', 'pending'].map((id, index) => {
    const input = { id, action: 'qa91.composition' };
    const normalized = normalizeEvent(input, { projectId: 'qa91-unit', receivedAt: new Date() });
    if (!normalized.ok) throw new Error(normalized.reason);
    return { index, input, row: normalized.row };
  });
}

it.each([true, false])('composes all unresolved/pending combinations for subset capability %s', async (capable) => {
  for (const unresolved of [false, true]) {
    for (const pending of [false, true]) {
      const input = candidates();
      vi.mocked(claimIngestReceipts).mockImplementation(async (projectId, organizationId, values) =>
        values.map((value) => ({ ...value, projectId, organizationId, expiresAt: new Date(Date.now() + 300_000) })),
      );
      vi.spyOn(isolation, 'isolateIngestRows').mockResolvedValue({
        written: input.filter((_, index) => index === 0 || (index === 2 && !unresolved) || (index === 3 && !pending)).map((c) => c.row),
        rejected: [input[1]!.row],
        unresolved: unresolved ? [input[2]!.row] : [],
        pending: pending ? [input[3]!.row] : [],
        unavailable: [],
        limited: unresolved,
        limitReason: unresolved ? 'bytes' : undefined,
      });
      const retryUnchecked = uncheckedIngestPolicy(capable, pending) === 'retry';
      expect(retryUnchecked).toBe(capable || pending);
      const result = await insertImmutableEvents('qa91-unit', 'qa91-org', input, capable).catch((error: unknown) => error);
      const retry = pending || (unresolved && capable);
      const expectedRejections = [
        { index: 1, code: 'invalid_event', reason: isolation.STORAGE_PARSE_REJECTION },
        ...(unresolved && !retryUnchecked ? [{ index: 2, code: 'unverified_after_parse_failure', reason: UNVERIFIED_PARSE_REJECTION }] : []),
      ];
      const ids = input.filter((_, index) => index === 0 || (index === 2 && !unresolved) || (index === 3 && !pending)).map((c) => c.row.event_id);
      if (retry) {
        expect(result).toMatchObject({
          status: 503,
          code: 'ingest_pending',
          details: { ids, rejected: expectedRejections, indices: [...(unresolved ? [2] : []), ...(pending ? [3] : [])] },
        });
      } else expect(result).toEqual({ ids, rejected: expectedRejections });
      vi.mocked(isolation.isolateIngestRows).mockRestore();
    }
  }
});

it.each(['ambiguous', 'held-claim conflict'])('legacy identical retries reach 202 after a %s settles', async (kind) => {
  const input = candidates();
  const receipts = input.map(({ row }) => ({
    projectId: 'qa91-unit',
    organizationId: 'qa91-org',
    eventId: row.event_id,
    fingerprint: eventFingerprint(row),
    receivedAt: new Date(row.received_at),
    eventAt: new Date(row.timestamp),
    claimedAt: new Date(),
    confirmedAt: null as Date | null,
    expiresAt: new Date(Date.now() + 300_000),
  }));
  if (kind === 'held-claim conflict')
    receipts[3]!.fingerprint = eventFingerprint({ ...input[3]!.row, payload: JSON.stringify({ id: 'pending', action: 'other-writer' }) });
  vi.mocked(findIngestReceipts).mockResolvedValue(kind === 'ambiguous' ? [] : [receipts[3]!]);
  vi.mocked(claimIngestReceipts).mockImplementation(async (_projectId, _organizationId, values) =>
    values.map((value) => ({ ...receipts.find((r) => r.eventId === value.eventId)!, ...value })),
  );
  const isolate = vi.spyOn(isolation, 'isolateIngestRows').mockResolvedValue({
    written: [input[0]!.row],
    rejected: [input[1]!.row],
    unresolved: [input[2]!.row],
    pending: kind === 'ambiguous' ? [input[3]!.row] : [],
    unavailable: [],
    limited: true,
    limitReason: 'bytes',
  });
  const first = await insertImmutableEvents('qa91-unit', 'qa91-org', input).catch((error: unknown) => error);
  expect(first).toMatchObject({
    status: 503,
    code: 'ingest_pending',
    details: { ids: ['written'], indices: [2, 3], rejected: [{ index: 1, code: 'invalid_event' }] },
  });
  // Recovery has confirmed the ambiguous write; the confirmed prefix is also skipped.
  receipts[0]!.confirmedAt = new Date();
  receipts[3]!.confirmedAt = new Date();
  vi.mocked(findIngestReceipts).mockResolvedValue([receipts[0]!, receipts[3]!]);
  isolate.mockResolvedValue({
    written: [],
    rejected: [input[1]!.row],
    unresolved: [input[2]!.row],
    pending: [],
    unavailable: [],
    limited: true,
    limitReason: 'bytes',
  });
  expect(await insertImmutableEvents('qa91-unit', 'qa91-org', input)).toEqual({
    ids: kind === 'ambiguous' ? ['written', 'pending'] : ['written'],
    rejected: [
      ...(kind === 'held-claim conflict'
        ? [{ index: 3, code: 'duplicate_id_conflict', reason: expect.stringMatching(/^duplicate_id_conflict:/) }]
        : []),
      { index: 1, code: 'invalid_event', reason: isolation.STORAGE_PARSE_REJECTION },
      { index: 2, code: 'unverified_after_parse_failure', reason: UNVERIFIED_PARSE_REJECTION },
    ],
  });
  expect(isolate.mock.calls[1]![0].map((row) => row.event_id)).toEqual(['bad', 'unchecked']);
});
