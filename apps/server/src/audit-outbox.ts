import { type AuditPayload, type Prisma, storeAuditEvent } from '@logbird/database';
import { ApiError } from './errors';
/** A committed mutation must keep its successful response even if Postgres becomes unavailable afterward. */
export async function queueAuditEvent(stream: string, event: AuditPayload, tx?: Prisma.TransactionClient) {
  // Owned mutations must roll back if their evidence cannot be committed.
  if (tx) {
    try {
      return await storeAuditEvent(stream, event, tx);
    } catch {
      throw new ApiError(503, 'audit_storage_unavailable', 'The change could not be recorded. Retry shortly.');
    }
  }
  try {
    await storeAuditEvent(stream, event);
  } catch {
    console.error(JSON.stringify({ event: 'audit.storage_unavailable', action: event.action }));
  }
}
