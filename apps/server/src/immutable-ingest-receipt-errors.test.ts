import { PrismaClientKnownRequestError } from '@prisma/client/runtime/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({
  find: vi.fn(),
  claim: vi.fn(),
  confirm: vi.fn(),
  release: vi.fn(),
  insert: vi.fn(),
  lookup: vi.fn(),
  retryAfter: vi.fn(),
  expire: vi.fn(),
  retryFingerprint: vi.fn(),
}));
vi.mock('@logbird/database', () => ({
  findIngestReceipts: fake.find,
  claimIngestReceipts: fake.claim,
  confirmIngestReceipts: fake.confirm,
  expireIngestReceipts: fake.expire,
  takeOverIngestReceipts: vi.fn(),
  INGEST_RECEIPT_WINDOW_MS: 600_000,
  prisma: { ingestReceipt: { deleteMany: fake.release } },
}));
vi.mock('@logbird/clickhouse', () => ({
  AmbiguousInsertError: class extends Error {},
  InsertLeaseExhaustedError: class extends Error {},
  // Parse isolation (#150) runs the inserts; these unit tests use definite non-parse failures only.
  isPrewriteParseError: () => false,
  INGEST_ASYNC_MAX_DATA_SIZE: 64 * 1024 * 1024,
  INSERT_LEASE_BUDGET_MS: 40_000,
  ASYNC_INSERT_FLUSH_BOUND_MS: 30_000,
  INGEST_CLAIM_LEASE_MS: 60_000,
  CLICKHOUSE_PARSE_ERROR_CODES: new Set(['27']),
  eventFingerprint: () => 'v1:qa',
  retryFingerprint: fake.retryFingerprint,
  existingEventIdentities: fake.lookup,
  insertEvents: fake.insert,
  normalizeEvent: vi.fn(),
  resolveTimestamp: vi.fn(),
}));
vi.mock('@logbird/worker/ingest-recovery', () => ({ ingestRecoveryRetryAfter: fake.retryAfter }));
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
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  fake.retryFingerprint.mockReturnValue('v1:qa');
  fake.find.mockResolvedValue([]);
  fake.claim.mockResolvedValue([receipt]);
  fake.lookup.mockResolvedValue(new Map());
  fake.retryAfter.mockResolvedValue(1);
  // insertEvents is async; parse isolation chains on its promise.
  fake.insert.mockResolvedValue(undefined);
  fake.confirm.mockImplementation(async (_project, values: unknown[]) => {
    if (values.length) throw conflict();
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it('returns a retryable unavailable mapping without holding claims when the claim statement conflicts', async () => {
  fake.claim.mockRejectedValueOnce(conflict());
  const error = await insertImmutableEvents('qa-project', 'qa-org', candidates).catch((error: unknown) => error);
  expect(ingestReceiptFailureResponse(error)).toMatchObject({ status: 503, retryAfter: '1', body: { error: { code: 'ingest_unavailable' } } });
  expect(fake.release).not.toHaveBeenCalled();
  expect(fake.insert).not.toHaveBeenCalled();
  expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('"level":"warn","event":"ingest.receipt_phase_failed","phase":"claim"'));
  expect(console.error).not.toHaveBeenCalled();
});

it('keeps acknowledged claims and reports the usual pending indices and Retry-After', async () => {
  const error = await insertImmutableEvents('qa-project', 'qa-org', candidates).catch((error: unknown) => error);
  expect(error).toBeInstanceOf(ApiError);
  expect(error).toMatchObject({
    status: 503,
    code: 'ingest_pending',
    retryAfter: 90,
    message: 'Storage accepted some events but receipt confirmation is unresolved. Retry this batch; listed indices are unresolved.',
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

const prismaFailure = (code: string) => Object.assign(new Error('private database detail'), { name: 'PrismaClientKnownRequestError', code });

it('maps a pre-insert database failure (pool timeout) to a retryable 503 without holding claims', async () => {
  fake.claim.mockRejectedValueOnce(prismaFailure('P2024'));
  const error = await insertImmutableEvents('qa-project', 'qa-org', candidates).catch((error: unknown) => error);
  expect(error).toBeInstanceOf(ApiError);
  expect(error).toMatchObject({ status: 503, code: 'ingest_unavailable', retryAfter: 1 });
  expect(String((error as Error).message)).not.toMatch(/private database detail/);
  expect(fake.insert).not.toHaveBeenCalled();
});

it('maps a receipt lookup failure before any claim to a retryable 503', async () => {
  fake.find.mockRejectedValueOnce(prismaFailure('P1017'));
  const error = await insertImmutableEvents('qa-project', 'qa-org', candidates).catch((error: unknown) => error);
  expect(error).toMatchObject({ status: 503, code: 'ingest_unavailable', retryAfter: 1 });
  expect(fake.claim).not.toHaveBeenCalled();
});

it('still surfaces a programming error before the insert', async () => {
  fake.claim.mockRejectedValueOnce(new TypeError('bug'));
  await expect(insertImmutableEvents('qa-project', 'qa-org', candidates)).rejects.toBeInstanceOf(TypeError);
});

it.each([
  [
    'a statement timeout',
    Object.assign(prismaFailure('P2010'), { meta: { driverAdapterError: { cause: { originalCode: '57014', kind: 'postgres' } } } }),
    'postgres',
  ],
  ['a pool timeout', prismaFailure('P2024')],
  ['an unknown failure', new Error('socket closed')],
  ['a programming error', new TypeError('private bug detail')],
  ['invalid SQL', Object.assign(prismaFailure('P2010'), { meta: { code: '42601' } })],
])('keeps acknowledged claims and reports pending indices after %s while confirming', async (_label, failure, kind?: string) => {
  fake.confirm.mockImplementation(async (_project, values: unknown[]) => {
    if (values.length) throw failure;
  });
  const error = await insertImmutableEvents('qa-project', 'qa-org', candidates).catch((error: unknown) => error);
  expect(error).toBeInstanceOf(ApiError);
  expect(error).toMatchObject({ status: 503, code: 'ingest_pending', details: { indices: [3], eventIds: ['qa-event'] } });
  expect((error as ApiError).retryAfter).toBeGreaterThanOrEqual(1);
  expect(fake.insert).toHaveBeenCalledTimes(1);
  expect(fake.release).not.toHaveBeenCalled();
  expect(console.error).toHaveBeenCalledWith(
    JSON.stringify({
      level: 'error',
      event: 'ingest.receipt_phase_failed',
      phase: 'confirm',
      name: failure.name,
      code: 'code' in failure ? failure.code : undefined,
      kind,
    }),
  );
});

it.each(['claim', 'classify', 'empty', 'insert'] as const)('handles and logs a failed claim release at %s', async (site) => {
  fake.release.mockRejectedValueOnce(prismaFailure('P2024'));
  if (site === 'claim') {
    // Claim one id, then fail while reloading a competing id.
    fake.find.mockResolvedValueOnce([]).mockRejectedValueOnce(prismaFailure('P1017'));
  } else if (site === 'classify') {
    fake.claim.mockResolvedValueOnce([{ ...receipt, eventAt: new Date(Number.NaN) }]);
  } else if (site === 'empty') {
    fake.claim.mockResolvedValueOnce([{ ...receipt, fingerprint: 'unreadable:qa' }]);
  } else {
    fake.insert.mockRejectedValueOnce(new Error('definite storage failure'));
  }
  const batch = site === 'claim' ? [...candidates, { ...candidates[0], row: { ...candidates[0]?.row, event_id: 'qa-competitor' } }] : candidates;
  const error = await insertImmutableEvents('qa-project', 'qa-org', batch as IngestCandidate[]).catch((error: unknown) => error);
  // Once an outcome exists, a failed release keeps it. After an insert, the row whose claim stays held is pending, with a
  // lease-aware Retry-After. With nothing to insert, every row is settled, so the settled response stands. Before any
  // outcome exists (claim, classification), the release failure is the retryable 503 itself.
  if (site === 'insert') expect(error).toMatchObject({ status: 503, code: 'ingest_pending', retryAfter: 90, details: { indices: [3] } });
  else if (site === 'empty') expect(error).toEqual({ ids: [], rejected: [expect.objectContaining({ index: 3, code: 'stored_event_unreadable' })] });
  else expect(error).toMatchObject({ status: 503, code: 'ingest_unavailable', retryAfter: 1 });
  expect(fake.release).toHaveBeenCalledTimes(1);
  expect(console.error).toHaveBeenCalledWith(
    expect.stringContaining('"event":"ingest.claim_release_failed","name":"PrismaClientKnownRequestError","code":"P2024"'),
  );
});

it('preserves the original ApiError when classification and release both fail and logs both codes', async () => {
  const original = new ApiError(503, 'project_busy', 'Project is busy.', undefined, 7);
  fake.claim.mockResolvedValueOnce([{ ...receipt, fingerprint: 'legacy' }]);
  fake.retryFingerprint.mockImplementationOnce(() => {
    throw original;
  });
  fake.release.mockRejectedValueOnce(prismaFailure('P2024'));
  await expect(insertImmutableEvents('qa-project', 'qa-org', candidates)).rejects.toBe(original);
  expect(console.error).toHaveBeenCalledWith(expect.stringContaining('"original":{"name":"Error","code":"project_busy"}'));
});

it.each(['57014', '55P03'])('maps the real P2039 model-query wrapper at releaseClaims/deleteMany (%s) to retryable unavailable', async (sqlstate) => {
  // A classification failure releases before any outcome exists, so the release failure is the response itself.
  fake.claim.mockResolvedValueOnce([{ ...receipt, eventAt: new Date(Number.NaN) }]);
  fake.release.mockRejectedValueOnce(
    new PrismaClientKnownRequestError('qa database failure', {
      code: 'P2039',
      clientVersion: '7.10.0',
      meta: {
        modelName: 'IngestReceipt',
        driverAdapterError: {
          name: 'DriverAdapterError',
          cause: { kind: 'postgres', originalCode: sqlstate, code: sqlstate, severity: 'ERROR', message: 'qa database failure' },
        },
      },
    }),
  );
  const error = await insertImmutableEvents('qa-project', 'qa-org', candidates).catch((error: unknown) => error);
  expect(error).toBeInstanceOf(ApiError);
  expect(error).toMatchObject({ status: 503, code: 'ingest_unavailable', retryAfter: 1 });
  expect(fake.release).toHaveBeenCalledExactlyOnceWith({ where: { projectId: 'qa-project', eventId: { in: ['qa-event'] }, confirmedAt: null } });
  expect(fake.insert).not.toHaveBeenCalled();
});

it('surfaces a plain Error from targeted expiry without mapping it to 503', async () => {
  const failure = new Error('fictional programming failure');
  fake.find.mockResolvedValueOnce([{ ...receipt, confirmedAt: new Date(now.getTime() - 700_000) }]);
  fake.expire.mockRejectedValueOnce(failure);
  const error = await insertImmutableEvents('qa-project', 'qa-org', candidates).catch((error: unknown) => error);
  expect(error).toBe(failure);
  expect(error).not.toBeInstanceOf(ApiError);
  expect(ingestReceiptFailureResponse(error)).toBeNull();
  expect(fake.claim).not.toHaveBeenCalled();
  expect(fake.insert).not.toHaveBeenCalled();
});

it('reports a definite storage refusal as retryable unavailable and releases only its claim', async () => {
  // A definite non-parse refusal (the body was never written): parse isolation files it as unavailable.
  fake.insert.mockRejectedValueOnce({ code: '516' });
  const error = await insertImmutableEvents('qa-project', 'qa-org', candidates).catch((error: unknown) => error);
  expect(error).toBeInstanceOf(ApiError);
  expect(error).toMatchObject({ status: 503, code: 'ingest_unavailable', retryAfter: 5, details: { indices: [3], eventIds: ['qa-event'] } });
  expect(fake.release).toHaveBeenCalledExactlyOnceWith({ where: { projectId: 'qa-project', eventId: { in: ['qa-event'] }, confirmedAt: null } });
  expect(fake.confirm).not.toHaveBeenCalledWith('qa-project', [expect.anything()]);
});

it('logs the adapter kind before mapping a pre-insert infrastructure failure', async () => {
  fake.claim.mockRejectedValueOnce({ name: 'DriverAdapterError', cause: { kind: 'ConnectionClosed' } });
  await expect(insertImmutableEvents('qa-project', 'qa-org', candidates)).rejects.toMatchObject({ code: 'ingest_unavailable', retryAfter: 1 });
  expect(console.error).toHaveBeenCalledWith(
    JSON.stringify({ level: 'error', event: 'ingest.receipt_phase_failed', phase: 'claim', name: 'DriverAdapterError', kind: 'ConnectionClosed' }),
  );
});

it.each(['lookup', 'expire', 'claim'] as const)('surfaces and logs a programming error during pre-insert %s', async (site) => {
  const error = Object.assign(new Error('private SQL detail'), { code: 'P2010', meta: { code: '42601' } });
  if (site === 'lookup') fake.find.mockRejectedValueOnce(error);
  else if (site === 'claim') fake.claim.mockRejectedValueOnce(error);
  else {
    fake.find.mockResolvedValueOnce([{ ...receipt, confirmedAt: new Date(now.getTime() - 700_000) }]);
    fake.expire.mockRejectedValueOnce(error);
  }
  await expect(insertImmutableEvents('qa-project', 'qa-org', candidates)).rejects.toBe(error);
  expect(console.error).toHaveBeenCalledWith(
    JSON.stringify({ level: 'error', event: 'ingest.receipt_phase_failed', phase: 'claim', name: 'Error', code: 'P2010' }),
  );
});

it('keeps the pending response when the recovery Retry-After lookup fails', async () => {
  fake.retryAfter.mockRejectedValueOnce(prismaFailure('P2024'));
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const error = await insertImmutableEvents('qa-project', 'qa-org', candidates).catch((error: unknown) => error);
  expect(error).toMatchObject({ status: 503, code: 'ingest_pending', details: { indices: [3] } });
  expect((error as ApiError).retryAfter).toBeGreaterThanOrEqual(1);
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('ingest.retry_after_unavailable'));
  warn.mockRestore();
});
