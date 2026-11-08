import {
  AmbiguousInsertError,
  ASYNC_INSERT_FLUSH_BOUND_MS,
  CLICKHOUSE_PARSE_ERROR_CODES,
  type EventRow,
  eventFingerprint,
  existingEventIdentities,
  INGEST_CLAIM_LEASE_MS,
  insertEvents,
  normalizeEvent,
  resolveTimestamp,
  retryFingerprint,
} from '@logbird/clickhouse';
import { ingestPendingDetailsSchema } from '@logbird/contracts';
import {
  claimIngestReceipts,
  confirmIngestReceipts,
  expireIngestReceipts,
  findIngestReceipts,
  INGEST_RECEIPT_WINDOW_MS,
  type IngestReceipt,
  prisma,
  takeOverIngestReceipts,
} from '@logbird/database';
import { ingestRecoveryRetryAfter } from '@logbird/worker/ingest-recovery';
import { clickhouse } from './clickhouse';
import { ApiError } from './errors';

export type IngestCandidate = { index: number; input: unknown; row: EventRow };
export const DUPLICATE_ID_CONFLICT =
  'duplicate_id_conflict: id already belongs to different content; the original is kept. Send corrections with a new id and context.parentEventId.';

async function lookup(projectId: string, ids: string[]) {
  try {
    return await existingEventIdentities(clickhouse, projectId, ids);
  } catch {
    throw new ApiError(503, 'ingest_unavailable', 'Event identity lookup is unavailable. Retry this batch.');
  }
}

/** Releases only this phase's claims. A recovered missing write is also safe to release after definite failure. */
async function releaseClaims(projectId: string, owned: Map<string, IngestReceipt>) {
  if (owned.size)
    await prisma.ingestReceipt.deleteMany({
      where: { projectId, eventId: { in: [...owned.keys()] }, confirmedAt: null },
    });
}

async function upgradeLegacyReceipts(projectId: string, cached: Map<string, IngestReceipt>, stored: Awaited<ReturnType<typeof lookup>>) {
  // Existing confirmed legacy receipts also need raw-input identity after rollout.
  await confirmIngestReceipts(
    projectId,
    [...stored]
      .filter(([id]) => cached.get(id)?.confirmedAt && !cached.get(id)?.fingerprint.startsWith('v1:'))
      .map(([eventId, identity]) => ({ eventId, ...identity })),
  );
}

async function takeOverReadyClaims(projectId: string, prior: IngestReceipt[], candidates: IngestCandidate[], owned: Map<string, IngestReceipt>) {
  const readyIds = prior
    .filter(
      (r) =>
        !r.confirmedAt &&
        !r.claimedAt &&
        candidates.some(
          (c) =>
            c.row.event_id === r.eventId && retryFingerprint(c.input, projectId, r.receivedAt, r.eventId, r.fingerprint, r.eventAt) === r.fingerprint,
        ),
    )
    .map((r) => r.eventId);
  if (!readyIds.length) return;
  for (const receipt of await takeOverIngestReceipts(projectId, readyIds)) owned.set(receipt.eventId, receipt);
}

async function recheckAfterPause(projectId: string, owned: Map<string, IngestReceipt>, stored: Awaited<ReturnType<typeof lookup>>, lookupAt: number) {
  // A fast claim cannot outlive another writer's confirmed receipt window. Use the clock after claiming.
  if (Date.now() - lookupAt < INGEST_RECEIPT_WINDOW_MS / 2) return false;
  const rechecked = await lookup(
    projectId,
    [...owned.keys()].filter((id) => !stored.has(id)),
  );
  await confirmIngestReceipts(
    projectId,
    [...rechecked].map(([eventId, identity]) => ({ eventId, ...identity })),
  );
  return true;
}

/** Claim/recheck owns release until it hands the claims to the insert phase. */
async function claimEvents(projectId: string, organizationId: string, candidates: IngestCandidate[], fingerprint: (row: EventRow) => string) {
  const unique = new Map<string, EventRow>();
  for (const { row } of candidates) if (!unique.has(row.event_id)) unique.set(row.event_id, row);
  const eventIds = [...unique.keys()].sort();
  const prior = await findIngestReceipts(projectId, eventIds);
  const cacheCutoff = new Date(Date.now() - INGEST_RECEIPT_WINDOW_MS);
  const expired = prior.filter((r) => r.confirmedAt && r.confirmedAt < cacheCutoff);
  if (expired.length) {
    try {
      await expireIngestReceipts(
        projectId,
        expired.map((r) => r.eventId),
        cacheCutoff,
      );
    } catch {
      throw new ApiError(503, 'ingest_unavailable', 'Event identity cache is unavailable. Retry this batch.');
    }
  }
  const cached = new Map(prior.filter((r) => !r.confirmedAt || r.confirmedAt >= cacheCutoff).map((r) => [r.eventId, r]));
  const lookupAt = Date.now();
  const stored = await lookup(
    projectId,
    eventIds.filter((id) => !cached.get(id)?.confirmedAt || !cached.get(id)?.fingerprint.startsWith('v1:')),
  );
  await upgradeLegacyReceipts(projectId, cached, stored);
  const values = eventIds
    .filter((id) => !cached.has(id))
    .map((id) => {
      const row = unique.get(id) as EventRow;
      const legacy = stored.get(id);
      return {
        eventId: id,
        fingerprint: legacy?.fingerprint ?? fingerprint(row),
        receivedAt: legacy?.receivedAt ?? new Date(row.received_at),
        eventAt: legacy?.eventAt ?? new Date(row.timestamp),
        confirmedAt: legacy ? new Date() : null,
        claimedAt: new Date(),
      };
    });
  const owned = new Map<string, IngestReceipt>();
  try {
    const inserted = await claimIngestReceipts(projectId, organizationId, values);
    for (const receipt of inserted) owned.set(receipt.eventId, receipt);
    await takeOverReadyClaims(projectId, prior, candidates, owned);
    const rechecked = await recheckAfterPause(projectId, owned, stored, lookupAt);
    // RETURNING already supplies this attempt's receipts. Only competitors (or a paused recheck)
    // can have changed the remaining identities while the shared project lock is held.
    const receipts = new Map(owned);
    const reloadIds = rechecked ? eventIds : eventIds.filter((id) => !owned.has(id));
    if (reloadIds.length) for (const receipt of await findIngestReceipts(projectId, reloadIds)) receipts.set(receipt.eventId, receipt);
    return { owned, receipts };
  } catch (error) {
    await releaseClaims(projectId, owned);
    throw error;
  }
}

/** Pure classification: the caller releases its claims if this phase throws. */
function classifyCandidates(
  projectId: string,
  candidates: IngestCandidate[],
  receipts: Map<string, IngestReceipt>,
  owned: Map<string, IngestReceipt>,
  fingerprintFor: (row: EventRow) => string,
) {
  const ids: string[] = [],
    rejected: { index: number; reason: string; code: string }[] = [],
    pending: { index: number; eventId: string }[] = [];
  const rows = new Map<string, EventRow>();
  for (const candidate of candidates) {
    const id = candidate.row.event_id;
    const receipt = receipts.get(id);
    if (!receipt) {
      pending.push({ index: candidate.index, eventId: id });
      continue;
    }
    if (!receipt.confirmedAt && !owned.has(id)) {
      pending.push({ index: candidate.index, eventId: id });
      continue;
    }
    if (receipt.fingerprint.startsWith('unreadable:')) {
      rejected.push({
        index: candidate.index,
        code: 'stored_event_unreadable',
        reason: 'stored_event_unreadable: retained evidence cannot be compared; keep it and send a correction with a new id.',
      });
      continue;
    }
    const planned = rows.get(id);
    // An unversioned ready receipt switches to canonical identity after its first planned row.
    const fingerprint = planned ? fingerprintFor(planned) : receipt.fingerprint;
    const sameTimestamp = candidate.row.timestamp === receipt.eventAt.toISOString();
    const candidateFingerprint =
      fingerprint.startsWith('v1:') && sameTimestamp
        ? fingerprintFor(candidate.row)
        : retryFingerprint(candidate.input, projectId, receipt.receivedAt, id, fingerprint, receipt.eventAt);
    if (candidateFingerprint !== fingerprint) {
      const value = candidate.input && typeof candidate.input === 'object' ? (candidate.input as Record<string, unknown>).occurredAt : undefined;
      const difference =
        resolveTimestamp(value, receipt.receivedAt).timestamp.getTime() === receipt.eventAt.getTime()
          ? 'Content differs.'
          : 'Resolved timestamp differs.';
      rejected.push({ index: candidate.index, code: 'duplicate_id_conflict', reason: `${DUPLICATE_ID_CONFLICT} ${difference}` });
      continue;
    }
    if (!receipt.confirmedAt && owned.has(id) && !rows.has(id)) {
      // Reuse validated fresh rows. Retries with an older receipt must retain its original clock.
      if (sameTimestamp && candidate.row.received_at === receipt.receivedAt.toISOString()) rows.set(id, candidate.row);
      else {
        const normalized = normalizeEvent(candidate.input, { projectId, receivedAt: receipt.receivedAt, sdk: candidate.row.sdk });
        if (!normalized.ok) throw new Error('Validated candidate cannot be normalized');
        normalized.row.event_id = id;
        rows.set(id, normalized.row);
      }
    }
    ids.push(id);
  }
  return { ids, rejected, pending, rows: [...rows.values()] };
}

/** Insert owns release before send and on definite failure. Unproven write outcomes retain the lease. */
async function persistRows(projectId: string, rows: EventRow[], owned: Map<string, IngestReceipt>, fingerprint: (row: EventRow) => string) {
  if (!rows.length) {
    await releaseClaims(projectId, owned);
    return;
  }
  let keepClaims = false;
  try {
    const expiresAt = Math.min(
      ...[...owned.values()].filter((c) => !c.confirmedAt).map((c) => (c.claimedAt?.getTime() ?? 0) + INGEST_CLAIM_LEASE_MS),
    );
    try {
      await insertEvents(clickhouse, rows, expiresAt);
    } catch (error) {
      if (error instanceof AmbiguousInsertError) {
        keepClaims = true;
        throw new ApiError(503, 'ingest_pending', 'Storage acknowledgement is unresolved. Retry this batch.');
      }
      if (error && typeof error === 'object' && 'code' in error && CLICKHOUSE_PARSE_ERROR_CODES.has(String(error.code)))
        throw new ApiError(422, 'invalid_event', 'Storage could not parse this batch. Check event field types and timestamps.');
      throw new ApiError(503, 'ingest_unavailable', 'Storage rejected this write. Retry this batch.');
    }
    // After acknowledgement, a Postgres failure must preserve the claim for a visibility retry.
    keepClaims = true;
    await confirmIngestReceipts(
      projectId,
      rows.map((row) => ({
        eventId: row.event_id,
        fingerprint: fingerprint(row),
        receivedAt: new Date(row.received_at),
        eventAt: new Date(row.timestamp),
      })),
    );
  } finally {
    if (!keepClaims) await releaseClaims(projectId, owned);
  }
}

/** Caller holds a project lock: exclusive during recovery, shared otherwise. Receipts fence every API process. */
export async function insertImmutableEvents(projectId: string, organizationId: string, candidates: IngestCandidate[]) {
  if (!candidates.length) return { ids: [] as string[], rejected: [] as { index: number; reason: string; code: string }[] };
  // The wire payload and normalized rows are immutable within this attempt; hash each row once.
  const fingerprints = new Map<EventRow, string>();
  const fingerprint = (row: EventRow) => {
    let value = fingerprints.get(row);
    if (!value) {
      value = eventFingerprint(row);
      fingerprints.set(row, value);
    }
    return value;
  };
  const { owned, receipts } = await claimEvents(projectId, organizationId, candidates, fingerprint);
  let result: ReturnType<typeof classifyCandidates>;
  try {
    result = classifyCandidates(projectId, candidates, receipts, owned, fingerprint);
  } catch (error) {
    await releaseClaims(projectId, owned);
    throw error;
  }
  try {
    await persistRows(projectId, result.rows, owned, fingerprint);
  } catch (error) {
    if (error instanceof ApiError && error.code === 'ingest_pending') {
      const pendingIds = new Set([...result.pending.map((p) => p.eventId), ...result.rows.map((r) => r.event_id)]);
      const pending = candidates.filter((c) => pendingIds.has(c.row.event_id));
      const ids = result.ids.filter((id) => !pendingIds.has(id));
      const unsettled = new Set(pending.map((c) => c.index));
      throw await pendingError(
        projectId,
        error.message,
        ids,
        result.rejected.filter((r) => !unsettled.has(r.index)),
        pending.map((c) => ({ index: c.index, eventId: c.row.event_id })),
        receipts,
      );
    }
    throw error;
  }
  // Healthy siblings are already durable; an identical batch retry will not insert them again.
  if (result.pending.length)
    throw await pendingError(
      projectId,
      'Some event ids have unresolved writes. Retry this batch; listed indices are unresolved.',
      result.ids,
      result.rejected,
      result.pending,
      receipts,
    );
  return { ids: result.ids, rejected: result.rejected };
}

async function pendingError(
  projectId: string,
  message: string,
  ids: string[],
  rejected: { index: number; reason: string; code: string }[],
  pending: { index: number; eventId: string }[],
  receipts: Map<string, IngestReceipt>,
) {
  const details = ingestPendingDetailsSchema.parse({
    accepted: ids.length,
    ids,
    rejected,
    warnings: [],
    indices: pending.map((p) => p.index),
    eventIds: pending.map((p) => p.eventId),
  });
  const now = Date.now();
  const retryAfter = Math.max(
    1,
    pending.some((p) => receipts.get(p.eventId)?.claimedAt) ? await ingestRecoveryRetryAfter(projectId) : 0,
    ...pending.map((p) => {
      const receipt = receipts.get(p.eventId);
      if (!receipt) return 1;
      const settlesAt = receipt.claimedAt
        ? receipt.claimedAt.getTime() + INGEST_CLAIM_LEASE_MS + ASYNC_INSERT_FLUSH_BOUND_MS
        : receipt.receivedAt.getTime() + INGEST_RECEIPT_WINDOW_MS;
      return Math.ceil((settlesAt - now) / 1000);
    }),
  );
  return new ApiError(503, 'ingest_pending', message, details, retryAfter);
}
