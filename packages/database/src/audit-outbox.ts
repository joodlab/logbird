import { randomUUID } from 'node:crypto';
import type { Prisma } from './generated/client';
import { prisma } from './index';

export const auditNamespace = () => process.env.BULLMQ_PREFIX ?? '{logbird}';

export type AuditPayload = Prisma.InputJsonObject & { action: string };
/** Freeze time, identity and JSON once. Never reconstruct an event during retry. */
export function freezeAuditEvent(event: AuditPayload) {
  const id = typeof event.id === 'string' ? event.id : randomUUID();
  const payload = JSON.parse(JSON.stringify({ ...event, id, occurredAt: event.occurredAt ?? new Date().toISOString() })) as AuditPayload;
  return { id, payload };
}
export async function storeAuditEvent(stream: string, event: AuditPayload, db: Prisma.TransactionClient = prisma) {
  if (!stream.startsWith('ws:') || stream.length <= 3) throw new Error('Audit destination must be a workspace stream');
  const frozen = freezeAuditEvent(event);
  // A supplied stable id must retain its original content; duplicate insertion cannot replace it.
  return db.auditOutbox.create({ data: { ...frozen, stream, namespace: auditNamespace() } });
}
