import {
  AmbiguousInsertError,
  CLICKHOUSE_PARSE_ERROR_CODES,
  type EventIdentity,
  type EventRow,
  eventFingerprint,
  existingEventIdentities,
  INGEST_CLAIM_LEASE_MS,
  insertEvents,
  matchesIdentity,
  normalizeEvent,
  retryFingerprint,
} from '@logbird/clickhouse';
import { confirmIngestReceipts, INGEST_RECEIPT_WINDOW_MS, type IngestReceipt, prisma, pruneIngestReceipts } from '@logbird/database';
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

/** Claim/recheck owns release until it hands the claims to the insert phase. */
async function claimEvents(projectId: string, organizationId: string, candidates: IngestCandidate[]) {
  await pruneIngestReceipts(projectId, true);
  const unique = new Map<string, EventRow>();
  for (const { row } of candidates) if (!unique.has(row.event_id)) unique.set(row.event_id, row);
  const eventIds = [...unique.keys()].sort();
  const prior = await prisma.ingestReceipt.findMany({ where: { projectId, eventId: { in: eventIds } } });
  const cached = new Map(prior.map((r) => [r.eventId, r]));
  const lookupAt = Date.now();
  const stored = await lookup(
    projectId,
    eventIds.filter((id) => !cached.get(id)?.confirmedAt || !cached.get(id)?.fingerprint.startsWith('v1:')),
  );
  // Existing confirmed legacy receipts also need raw-input identity after rollout.
  await confirmIngestReceipts(
    projectId,
    [...stored]
      .filter(([id]) => cached.get(id)?.confirmedAt && !cached.get(id)?.fingerprint.startsWith('v1:'))
      .map(([eventId, identity]) => ({ eventId, ...identity })),
  );
  const values = eventIds
    .filter((id) => !cached.has(id))
    .map((id) => {
      const row = unique.get(id) as EventRow;
      const legacy = stored.get(id);
      return {
        projectId,
        eventId: id,
        organizationId,
        fingerprint: legacy?.fingerprint ?? eventFingerprint(row),
        receivedAt: legacy?.receivedAt ?? new Date(row.received_at),
        eventAt: legacy?.eventAt ?? new Date(row.timestamp),
        confirmedAt: legacy ? new Date() : null,
        claimedAt: new Date(),
      };
    });
  const owned = new Map<string, IngestReceipt>();
  try {
    const inserted = values.length ? await prisma.ingestReceipt.createManyAndReturn({ data: values, skipDuplicates: true }) : [];
    for (const receipt of inserted) owned.set(receipt.eventId, receipt);
    // A reconciled missing receipt is ready to be retried, retaining the first receive clock.
    const readyIds = prior
      .filter(
        (r) =>
          !r.confirmedAt &&
          !r.claimedAt &&
          candidates.some(
            (c) => c.row.event_id === r.eventId && retryFingerprint(c.input, projectId, r.receivedAt, r.eventId, r.fingerprint) === r.fingerprint,
          ),
      )
      .map((r) => r.eventId);
    if (readyIds.length)
      for (const receipt of await prisma.ingestReceipt.updateManyAndReturn({
        where: { projectId, eventId: { in: readyIds }, confirmedAt: null, claimedAt: null },
        data: { claimedAt: new Date() },
      }))
        owned.set(receipt.eventId, receipt);
    // A fast claim cannot outlive another writer's confirmed receipt window. Recheck only after a long pause.
    const recheckIds = [...owned]
      .filter(([id, claim]) => !stored.has(id) && (claim.claimedAt?.getTime() ?? 0) - lookupAt >= INGEST_RECEIPT_WINDOW_MS / 2)
      .map(([id]) => id);
    const rechecked = await lookup(projectId, recheckIds);
    for (const [eventId, identity] of rechecked) {
      stored.set(eventId, identity);
    }
    await confirmIngestReceipts(
      projectId,
      [...rechecked].map(([eventId, identity]) => ({ eventId, ...identity })),
    );
    const receipts = new Map((await prisma.ingestReceipt.findMany({ where: { projectId, eventId: { in: eventIds } } })).map((r) => [r.eventId, r]));
    return { owned, receipts, stored };
  } catch (error) {
    await releaseClaims(projectId, owned);
    throw error;
  }
}

async function classifyCandidates(
  projectId: string,
  candidates: IngestCandidate[],
  receipts: Map<string, IngestReceipt>,
  stored: Map<string, EventIdentity>,
  owned: Map<string, IngestReceipt>,
) {
  const ids: string[] = [],
    rejected: { index: number; reason: string }[] = [],
    pending: { index: number; eventId: string }[] = [];
  const rows = new Map<string, EventRow>();
  const confirmations: { eventId: string; fingerprint: string; receivedAt: Date; eventAt: Date }[] = [];
  for (const candidate of candidates) {
    const id = candidate.row.event_id;
    const receipt = receipts.get(id);
    if (!receipt) {
      pending.push({ index: candidate.index, eventId: id });
      continue;
    }
    if (!receipt.confirmedAt && !owned.has(id)) {
      const existing = stored.get(id);
      if (!existing || !matchesIdentity(receipt.fingerprint, existing)) {
        pending.push({ index: candidate.index, eventId: id });
        continue;
      }
      confirmations.push({ eventId: id, ...existing });
    }
    const planned = rows.get(id);
    const fingerprint = planned ? eventFingerprint(planned) : receipt.fingerprint;
    if (retryFingerprint(candidate.input, projectId, receipt.receivedAt, id, fingerprint) !== fingerprint) {
      rejected.push({ index: candidate.index, reason: DUPLICATE_ID_CONFLICT });
      continue;
    }
    if (!receipt.confirmedAt && owned.has(id) && !rows.has(id)) {
      const normalized = normalizeEvent(candidate.input, { projectId, receivedAt: receipt.receivedAt, sdk: candidate.row.sdk });
      if (!normalized.ok) throw new Error('Validated candidate cannot be normalized');
      normalized.row.event_id = id;
      rows.set(id, normalized.row);
    }
    ids.push(id);
  }
  await confirmIngestReceipts(projectId, confirmations);
  return { ids, rejected, pending, rows: [...rows.values()] };
}

/** Insert owns release before send and on definite failure. Only transport ambiguity retains the lease. */
async function persistRows(projectId: string, rows: EventRow[], owned: Map<string, IngestReceipt>) {
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
        fingerprint: eventFingerprint(row),
        receivedAt: new Date(row.received_at),
        eventAt: new Date(row.timestamp),
      })),
    );
  } finally {
    if (!keepClaims) await releaseClaims(projectId, owned);
  }
}

/** Caller holds the shared project lock. Unique receipts fence every API process. */
export async function insertImmutableEvents(projectId: string, organizationId: string, candidates: IngestCandidate[]) {
  if (!candidates.length) return { ids: [] as string[], rejected: [] as { index: number; reason: string }[] };
  const { owned, receipts, stored } = await claimEvents(projectId, organizationId, candidates);
  let result: Awaited<ReturnType<typeof classifyCandidates>>;
  try {
    result = await classifyCandidates(projectId, candidates, receipts, stored, owned);
  } catch (error) {
    await releaseClaims(projectId, owned);
    throw error;
  }
  try {
    await persistRows(projectId, result.rows, owned);
  } catch (error) {
    if (error instanceof ApiError && error.code === 'ingest_pending') {
      const pendingIds = new Set([...result.pending.map((p) => p.eventId), ...result.rows.map((r) => r.event_id)]);
      const pending = candidates.filter((c) => pendingIds.has(c.row.event_id));
      throw new ApiError(503, error.code, error.message, { indices: pending.map((c) => c.index), eventIds: pending.map((c) => c.row.event_id) });
    }
    throw error;
  }
  // Healthy siblings are already durable; an identical batch retry will not insert them again.
  if (result.pending.length)
    throw new ApiError(503, 'ingest_pending', 'Some event ids have unresolved writes. Retry this batch.', {
      indices: result.pending.map((p) => p.index),
      eventIds: result.pending.map((p) => p.eventId),
    });
  return { ids: result.ids, rejected: result.rejected };
}
