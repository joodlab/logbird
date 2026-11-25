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
  if (
    !Array.isArray(ids) ||
    accepted !== ids.length ||
    !Array.isArray(rejected) ||
    ids.length + rejected.length > events.length ||
    ((partial || warnings !== undefined) && !Array.isArray(warnings))
  )
    return;

  const rejections = new Map<number, IngestRejectionCode | undefined>();
  const unresolved = new Set<number>();
  const credit = new Map<string, number>();
  const wireIds = events.map((event) => event.id?.trim());
  for (const entry of rejected) {
    const { index, reason, code } = object(entry);
    if (typeof index !== 'number' || !Number.isInteger(index) || !events[index] || typeof reason !== 'string' || rejections.has(index)) return;
    rejections.set(index, typeof code === 'string' && rejectionCodes.has(code) ? (code as IngestRejectionCode) : undefined);
  }
  if (partial) {
    if (!Array.isArray(indices) || !Array.isArray(eventIds) || indices.length !== eventIds.length || indices.length > events.length) return;
    for (const [position, index] of indices.entries()) {
      if (!Number.isInteger(index) || !events[index] || wireIds[index] !== eventIds[position] || unresolved.has(index) || rejections.has(index))
        return;
      unresolved.add(index);
    }
  }
  for (const id of ids) {
    if (typeof id !== 'string' || id.length === 0) return;
    credit.set(id, (credit.get(id) ?? 0) + 1);
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
  if (credit.size) return;
  return { rejected: rejections, delivered };
}
