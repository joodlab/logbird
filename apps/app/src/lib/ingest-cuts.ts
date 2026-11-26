import { type AuditEvent, EVENT_LIMITS, TRUNCATED_ATTRIBUTES } from '@logbird/contracts';

/** A count Logbird recorded at ingest: decimal text in a reserved attribute, else null. */
function count(event: Pick<AuditEvent, 'attributes'>, key: string) {
  const raw = event.attributes[key];
  return raw !== undefined && /^\d{1,9}$/.test(raw) ? Number(raw) : null;
}
const list = (payload: unknown, key: 'targets' | 'changes') =>
  payload !== null && typeof payload === 'object' && Array.isArray((payload as Record<string, unknown>)[key])
    ? ((payload as Record<string, unknown>)[key] as unknown[])
    : null;

export type IngestCuts = {
  /** The event had more targets than were indexed: `indexed` of `sent`. */
  targets: { indexed: number; sent: number } | null;
  /** The event had more changes than were indexed: `indexed` of `sent`. */
  changes: { indexed: number; sent: number } | null;
  /** How many change field names were cut in the index. */
  changeFields: number | null;
};
const NONE: IngestCuts = { targets: null, changes: null, changeFields: null };

/**
 * What ingest cut from this event's indexed copy (`logbird.truncated.*`), confirmed by the original payload. Only
 * Logbird writes these keys on events it stores now, but an event stored by an earlier release may hold a producer
 * value under them; a count is shown only when the payload agrees with it, so the note can also point to the payload.
 * Without the payload (still loading, failed, or not fetched) nothing is shown.
 */
export function ingestCuts(event: Pick<AuditEvent, 'attributes' | 'targets' | 'changes'>, payload: unknown): IngestCuts {
  if (payload === undefined) return NONE;
  const sentTargets = count(event, TRUNCATED_ATTRIBUTES.targets);
  const sentChanges = count(event, TRUNCATED_ATTRIBUTES.changes);
  const fields = count(event, TRUNCATED_ATTRIBUTES.changeFields);
  const targets = list(payload, 'targets');
  const changes = list(payload, 'changes');
  const longFields =
    changes?.slice(0, EVENT_LIMITS.changes).filter((c) => {
      const field = c !== null && typeof c === 'object' ? (c as { field?: unknown }).field : undefined;
      return typeof field === 'string' && field.trim().length > EVENT_LIMITS.changeField;
    }).length ?? 0;
  return {
    targets:
      sentTargets !== null && sentTargets > event.targets.length && targets?.length === sentTargets
        ? { indexed: event.targets.length, sent: sentTargets }
        : null,
    changes:
      sentChanges !== null && sentChanges > event.changes.length && changes?.length === sentChanges
        ? { indexed: event.changes.length, sent: sentChanges }
        : null,
    changeFields: fields && fields === longFields ? fields : null,
  };
}
