import { type AuditEvent, TRUNCATED_ATTRIBUTES } from '@logbird/contracts';

/** A count Logbird recorded at ingest: decimal text in a reserved attribute, else null. */
function count(event: Pick<AuditEvent, 'attributes'>, key: string) {
  const raw = event.attributes[key];
  return raw !== undefined && /^\d{1,9}$/.test(raw) ? Number(raw) : null;
}

export type IngestCuts = {
  /** The event had more targets than were indexed: `indexed` of `sent`. */
  targets: { indexed: number; sent: number } | null;
  /** The event had more changes than were indexed: `indexed` of `sent`. */
  changes: { indexed: number; sent: number } | null;
  /** How many change field names were cut in the index. */
  changeFields: number | null;
};

/**
 * What ingest cut from this event's indexed copy (`logbird.truncated.*`, which only Logbird writes). The stored payload
 * keeps everything; events stored before these attributes existed show no cut.
 */
export function ingestCuts(event: Pick<AuditEvent, 'attributes' | 'targets' | 'changes'>): IngestCuts {
  const sentTargets = count(event, TRUNCATED_ATTRIBUTES.targets);
  const sentChanges = count(event, TRUNCATED_ATTRIBUTES.changes);
  const fields = count(event, TRUNCATED_ATTRIBUTES.changeFields);
  return {
    targets: sentTargets !== null && sentTargets > event.targets.length ? { indexed: event.targets.length, sent: sentTargets } : null,
    changes: sentChanges !== null && sentChanges > event.changes.length ? { indexed: event.changes.length, sent: sentChanges } : null,
    changeFields: fields ? fields : null,
  };
}
