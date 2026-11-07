import { type AuditPayload, storeAuditEvent } from '@logbird/database';
/** A committed mutation must keep its successful response even if Postgres becomes unavailable afterward. */
export async function queueAuditEvent(stream: string, event: AuditPayload) {
  try {
    await storeAuditEvent(stream, event);
  } catch {
    console.error(JSON.stringify({ event: 'audit.storage_unavailable', action: event.action }));
  }
}
