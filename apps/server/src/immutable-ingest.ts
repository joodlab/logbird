import {
  AmbiguousInsertError,
  ASYNC_INSERT_FLUSH_BOUND_MS,
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
import { isolateIngestRows, STORAGE_PARSE_REJECTION } from './ingest-parse-isolation';
import { ingestReceiptFailureResponse, isDatabaseFailure, receiptErrorDetails } from './ingest-receipt-errors';

export type IngestCandidate = { index: number; input: unknown; row: EventRow };
export const DUPLICATE_ID_CONFLICT =
  'duplicate_id_conflict: id conflicts with different content in this request or stored history. Send corrections with a new id and context.parentEventId.';

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

function logClaimReleaseFailure(error: unknown, originalError?: unknown) {
  console.error(
    JSON.stringify({
      level: 'error',
      event: 'ingest.claim_release_failed',
      ...receiptErrorDetails(error),
      original: originalError === undefined ? undefined : receiptErrorDetails(originalError),
    }),
  );
}

/** Releases claims while a request is already failing with `originalError`, which always stands. */
async function releaseClaimsSafely(projectId: string, owned: Map<string, IngestReceipt>, originalError: unknown) {
  try {
    await releaseClaims(projectId, owned);
  } catch (error) {
    logClaimReleaseFailure(error, originalError);
    // Keep the original outcome, even when cleanup also failed: an ApiError or infrastructure failure is mapped by its
    // caller (claimEvents, app.onError), and a programming error must surface as one, not as a retryable 503 that a
    // client would repeat every second. The claims stay held until recovery settles them.
    throw originalError;
  }
}

function logReceiptPhaseFailure(phase: 'claim' | 'confirm', error: unknown) {
  const level = phase === 'claim' && ingestReceiptFailureResponse(error) ? 'warn' : 'error';
  console[level](JSON.stringify({ level, event: 'ingest.receipt_phase_failed', phase, ...receiptErrorDetails(error) }));
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

/** Before insert, release owned claims on failure; a failed release leaves abandoned claims for recovery. */
async function claimEvents(projectId: string, organizationId: string, candidates: IngestCandidate[], fingerprint: (row: EventRow) => string) {
  try {
    return await claimPhase(projectId, organizationId, candidates, fingerprint);
  } catch (error) {
    if (!(error instanceof ApiError)) logReceiptPhaseFailure('claim', error);
    if (!(error instanceof ApiError) && isDatabaseFailure(error))
      throw new ApiError(503, 'ingest_unavailable', 'Event identity cache is unavailable. Retry this batch.', undefined, 1);
    throw error;
  }
}

/** Claim/recheck owns release until it hands the claims to the insert phase. */
async function claimPhase(projectId: string, organizationId: string, candidates: IngestCandidate[], fingerprint: (row: EventRow) => string) {
  const unique = new Map<string, EventRow>();
  for (const { row } of candidates) if (!unique.has(row.event_id)) unique.set(row.event_id, row);
  const eventIds = [...unique.keys()].sort();
  const prior = await findIngestReceipts(projectId, eventIds);
  const cacheCutoff = new Date(Date.now() - INGEST_RECEIPT_WINDOW_MS);
  const expired = prior.filter((r) => r.confirmedAt && r.confirmedAt < cacheCutoff);
  if (expired.length) {
    await expireIngestReceipts(
      projectId,
      expired.map((r) => r.eventId),
      cacheCutoff,
    );
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
    if (reloadIds.length) {
      // A paused request must re-apply the receipt window: an expired confirmation is no longer authoritative.
      // Its id stays pending (retryable); the retry expires it and consults stored evidence instead.
      const reloadCutoff = new Date(Date.now() - INGEST_RECEIPT_WINDOW_MS);
      for (const receipt of await findIngestReceipts(projectId, reloadIds))
        if (owned.has(receipt.eventId) || !receipt.confirmedAt || receipt.confirmedAt >= reloadCutoff) receipts.set(receipt.eventId, receipt);
    }
    return { owned, receipts };
  } catch (error) {
    await releaseClaimsSafely(projectId, owned, error);
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
  const empty = { written: [], rejected: [], pending: [], unavailable: [], unresolved: [], limited: false, unconfirmed: false };
  if (!rows.length) {
    try {
      await releaseClaims(projectId, owned);
    } catch (error) {
      logClaimReleaseFailure(error);
      if (!isDatabaseFailure(error)) throw error;
      // Nothing to insert: every row is already settled (confirmed elsewhere or terminally rejected), so a held claim
      // can't change any result. Keep the settled response; recovery clears the claims after their lease.
    }
    return empty;
  }
  const releasable = new Map(owned);
  let persisted: Awaited<ReturnType<typeof isolateIngestRows>> & { unconfirmed: boolean };
  try {
    const expiresAt = Math.min(
      ...[...owned.values()].filter((c) => !c.confirmedAt).map((c) => (c.claimedAt?.getTime() ?? 0) + INGEST_CLAIM_LEASE_MS),
    );
    // Keep claims as soon as a statement may have written, so even an unexpected throw later in isolation can never
    // release a claim for a row that is already stored.
    const keepClaims = (part: EventRow[]) => {
      for (const row of part) releasable.delete(row.event_id);
    };
    const outcome = await isolateIngestRows(rows, expiresAt, (part, body) =>
      insertEvents(clickhouse, part, expiresAt, body).then(
        () => keepClaims(part),
        (error: unknown) => {
          if (error instanceof AmbiguousInsertError) keepClaims(part);
          throw error;
        },
      ),
    );
    if (outcome.limited)
      console.warn(
        JSON.stringify({
          level: 'warn',
          event: 'ingest.parse_isolation_limited',
          projectId,
          unresolved: outcome.unresolved.length,
          reason: outcome.limitReason,
        }),
      );
    // After acknowledgement, a Postgres failure must preserve the claim for a visibility retry.
    for (const row of [...outcome.written, ...outcome.pending]) releasable.delete(row.event_id);
    try {
      await confirmIngestReceipts(
        projectId,
        outcome.written.map((row) => ({
          eventId: row.event_id,
          fingerprint: fingerprint(row),
          receivedAt: new Date(row.received_at),
          eventAt: new Date(row.timestamp),
        })),
      );
      persisted = { ...outcome, unconfirmed: false };
    } catch (error) {
      // ClickHouse acknowledged these rows, so any confirmation failure (a receipt conflict, infrastructure or even a
      // bug) keeps their claims and reports them as pending; composeIngestOutcome adds indices and Retry-After.
      if (!(error instanceof ApiError)) logReceiptPhaseFailure('confirm', error);
      persisted = { ...outcome, written: [], pending: [...outcome.pending, ...outcome.written], unconfirmed: outcome.written.length > 0 };
    }
  } catch (error) {
    // Isolation catches every insert outcome, so this is unexpected: release only proven-unwritten claims.
    await releaseClaimsSafely(projectId, releasable, error);
    throw error;
  }
  try {
    await releaseClaims(projectId, releasable);
  } catch (error) {
    logClaimReleaseFailure(error);
    if (!isDatabaseFailure(error)) throw error;
    // Those claims stay held until their lease lets recovery settle them. Keep the composed outcome (indices,
    // settled results) and report the affected retryable rows as pending, so Retry-After follows the held lease.
    // Proven-bad rows stay rejected: their outcome is terminal whatever happens to the claim. While Postgres is failing,
    // this also turns #150's terminal unverified_after_parse_failure into a retry for old clients; that is bounded by
    // the lease and returns to normal once the database does.
    const held = (row: EventRow) => releasable.has(row.event_id);
    persisted = {
      ...persisted,
      pending: [...persisted.pending, ...persisted.unavailable.filter(held), ...persisted.unresolved.filter(held)],
      unavailable: persisted.unavailable.filter((row) => !held(row)),
      unresolved: persisted.unresolved.filter((row) => !held(row)),
    };
  }
  return persisted;
}

/** Caller holds a project lock: exclusive during recovery, shared otherwise. Receipts fence every API process. */
export async function insertImmutableEvents(projectId: string, organizationId: string, candidates: IngestCandidate[], supportsSubsetRetry = false) {
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
    await releaseClaimsSafely(projectId, owned, error);
    throw error;
  }
  const outcome = await persistRows(projectId, result.rows, owned, fingerprint);
  return composeIngestOutcome(projectId, candidates, result, outcome, receipts, supportsSubsetRetry);
}

export const UNVERIFIED_PARSE_REJECTION =
  'unverified_after_parse_failure: Storage stopped checking this batch after parse failures; resend this event individually if needed.';

/**
 * Rows left unchecked are rejected terminally only for clients that can't resend a subset, only when isolation really
 * started after a proven parse failure (`isolationStarted`), and never inside a retryable response (old SDKs ignore
 * its details). Rows deferred before any statement ran (e.g. the lease was too short for the original INSERT) are
 * healthy-but-unsent and stay retryable for every client.
 */
export function uncheckedIngestPolicy(supportsSubsetRetry: boolean, hasOtherRetryableRows: boolean, isolationStarted: boolean) {
  return supportsSubsetRetry || hasOtherRetryableRows || !isolationStarted ? 'retry' : 'reject';
}

async function composeIngestOutcome(
  projectId: string,
  candidates: IngestCandidate[],
  result: ReturnType<typeof classifyCandidates>,
  outcome: Awaited<ReturnType<typeof persistRows>>,
  receipts: Map<string, IngestReceipt>,
  supportsSubsetRetry: boolean,
) {
  const unresolvedIds = new Set(outcome.unresolved.map((row) => row.event_id));
  const rejectedIds = new Set(outcome.rejected.map((row) => row.event_id));
  const pendingIds = new Set([...result.pending.map((p) => p.eventId), ...outcome.pending.map((row) => row.event_id)]);
  const unavailableIds = new Set(outcome.unavailable.map((row) => row.event_id));
  const rejectUnchecked = uncheckedIngestPolicy(supportsSubsetRetry, pendingIds.size + unavailableIds.size > 0, outcome.limited) === 'reject';
  // Classification rejections (including conflicts with another index of the same id) stay settled.
  const classifiedRejections = new Set(result.rejected.map((r) => r.index));
  for (const candidate of candidates) {
    if (classifiedRejections.has(candidate.index)) continue;
    const id = candidate.row.event_id;
    if (rejectedIds.has(id))
      result.rejected.push({
        index: candidate.index,
        code: 'invalid_event',
        reason: STORAGE_PARSE_REJECTION,
      });
    else if (rejectUnchecked && unresolvedIds.has(id))
      result.rejected.push({ index: candidate.index, code: 'unverified_after_parse_failure', reason: UNVERIFIED_PARSE_REJECTION });
  }
  const ids = result.ids.filter((id) => !rejectedIds.has(id) && !pendingIds.has(id) && !unavailableIds.has(id) && !unresolvedIds.has(id));
  // Healthy siblings are already durable; an identical batch retry will not insert them again.
  const retryableIds = new Set([...pendingIds, ...unavailableIds, ...(rejectUnchecked ? [] : unresolvedIds)]);
  if (retryableIds.size) {
    const retryable = candidates
      .filter((c) => retryableIds.has(c.row.event_id) && !classifiedRejections.has(c.index))
      .map((c) => ({ index: c.index, eventId: c.row.event_id }));
    throw await pendingError(
      projectId,
      ids,
      result.rejected,
      retryable,
      receipts,
      pendingIds,
      pendingIds.size || unresolvedIds.size ? 'ingest_pending' : 'ingest_unavailable',
      outcome.limited,
      unavailableIds.size > 0,
      outcome.unconfirmed,
    );
  }
  return { ids, rejected: result.rejected };
}

/** Best effort: a failed lookup must not lose the pending response; the per-receipt bounds below still apply. */
async function recoveryRetryAfter(projectId: string) {
  try {
    return await ingestRecoveryRetryAfter(projectId);
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined;
    console.warn(JSON.stringify({ level: 'warn', event: 'ingest.retry_after_unavailable', projectId, code }));
    return 1;
  }
}

async function pendingError(
  projectId: string,
  ids: string[],
  rejected: { index: number; reason: string; code: string }[],
  pending: { index: number; eventId: string }[],
  receipts: Map<string, IngestReceipt>,
  pendingIds: ReadonlySet<string>,
  code: 'ingest_pending' | 'ingest_unavailable',
  limited = false,
  storageRefused = code === 'ingest_unavailable',
  unconfirmed = false,
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
  const held = pending.filter((p) => pendingIds.has(p.eventId));
  const retryAfter = Math.max(
    // Storage definitely refused some rows: don't retry it every second, even when unchecked rows ride along.
    !held.length && storageRefused ? 5 : 1,
    held.some((p) => receipts.get(p.eventId)?.claimedAt) ? await recoveryRetryAfter(projectId) : 0,
    ...held.map((p) => {
      const receipt = receipts.get(p.eventId);
      if (!receipt) return 1;
      const settlesAt = receipt.claimedAt
        ? receipt.claimedAt.getTime() + INGEST_CLAIM_LEASE_MS + ASYNC_INSERT_FLUSH_BOUND_MS
        : receipt.receivedAt.getTime() + INGEST_RECEIPT_WINDOW_MS;
      return Math.ceil((settlesAt - now) / 1000);
    }),
  );
  return new ApiError(
    503,
    code,
    unconfirmed
      ? 'Storage accepted some events but receipt confirmation is unresolved. Retry this batch; listed indices are unresolved.'
      : limited
        ? 'Some events need a retry; listed indices are unresolved. Send smaller batches if isolation repeatedly reaches its limit.'
        : 'Some events need a retry; listed indices are unresolved.',
    details,
    retryAfter,
  );
}
