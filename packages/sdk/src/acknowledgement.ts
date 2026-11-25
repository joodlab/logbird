import type { EventInput, IngestRejectionCode } from './index';

const rejectionCodes: ReadonlySet<string> = new Set([
  'invalid_event',
  'invalid_event_id',
  'duplicate_id_conflict',
  'stored_event_unreadable',
  'unverified_after_parse_failure',
] satisfies IngestRejectionCode[]);

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function acknowledge(value: unknown, events: readonly EventInput[], partial: boolean) {
  const error = object(object(value).error);
  if (partial && error.code !== 'ingest_pending' && error.code !== 'ingest_unavailable') return;
  const { accepted, ids, rejected, warnings, indices, eventIds } = object(partial ? error.details : value);
  const validIds = Array.isArray(ids) && accepted === ids.length && ids.length <= events.length;
  if (!partial && !validIds) return;
  const rejections = new Map<number, IngestRejectionCode | undefined>();
  if (Array.isArray(rejected)) {
    for (const entry of rejected) {
      const { index, reason, code } = object(entry);
      if (typeof index !== 'number' || !Number.isInteger(index) || !events[index] || typeof reason !== 'string' || rejections.has(index)) continue;
      rejections.set(index, typeof code === 'string' && rejectionCodes.has(code) ? (code as IngestRejectionCode) : undefined);
    }
  }
  const incomplete = { rejected: rejections, delivered: undefined };
  if (
    !validIds ||
    !Array.isArray(rejected) ||
    rejected.length !== rejections.size ||
    ((partial || warnings !== undefined) && !Array.isArray(warnings))
  )
    return incomplete;
  const unresolved = new Set<number>();
  const credit = new Map<string, number>();
  const wireIds = events.map((event) => event.id?.trim());
  if (partial) {
    if (!Array.isArray(indices) || !Array.isArray(eventIds) || indices.length !== eventIds.length || indices.length > events.length)
      return incomplete;
    for (const [position, index] of indices.entries()) {
      if (!Number.isInteger(index) || !events[index] || wireIds[index] !== eventIds[position] || unresolved.has(index) || rejections.has(index))
        return incomplete;
      unresolved.add(index);
    }
  }
  // A 503 must say which positions remain. Without them, its ID list is ambiguous.
  if (partial && ids.length + rejections.size + unresolved.size !== events.length) return incomplete;
  for (const id of ids) {
    if (typeof id !== 'string' || id.length === 0) return incomplete;
    credit.set(id, (credit.get(id) ?? 0) + 1);
  }
  if (!partial) {
    const occurrences = new Map<string, number>();
    for (const [index, id] of wireIds.entries()) {
      if (id !== undefined && !rejections.has(index)) occurrences.set(id, (occurrences.get(id) ?? 0) + 1);
    }
    for (const [id, count] of credit) {
      const candidates = occurrences.get(id) ?? 0;
      if (count > candidates) return incomplete;
      // A partial success can credit unique IDs, but must not guess which duplicate content was stored.
      if (count < candidates) credit.delete(id);
    }
  }
  const delivered = new Set<number>();
  for (const [index, id] of wireIds.entries()) {
    if (id === undefined || rejections.has(index) || unresolved.has(index)) continue;
    const count = credit.get(id);
    if (!count) continue;
    delivered.add(index);
    if (count === 1) credit.delete(id);
    else credit.set(id, count - 1);
  }
  if (credit.size) return incomplete;
  return { rejected: rejections, delivered };
}
