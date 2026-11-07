import { createHash } from 'node:crypto';
import type { ClickHouseClient } from './client';
import { type EventRow, normalizeEvent } from './normalize';
import { read } from './queries';

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, child]) => [key, sorted(child)]),
    );
  return value;
}

/** Compatibility only: receipts written before v1 hashed lossy indexed columns. */
export function legacyEventFingerprint(row: EventRow) {
  const { received_at: _received, payload: _payload, sdk: _sdk, ...content } = row;
  return createHash('sha256')
    .update(JSON.stringify(sorted(content)))
    .digest('hex');
}

/** v1 is canonical parsed INPUT plus resolved time. Never hash the lossy search columns. */
export function eventFingerprint(row: EventRow) {
  const input = JSON.parse(row.payload);
  return `v1:${createHash('sha256')
    .update(JSON.stringify(sorted({ input, timestamp: row.timestamp })))
    .digest('hex')}`;
}

/** Use the first receipt's clock so omitted/invalid occurredAt stays idempotent on later retries. */
export function retryFingerprint(input: unknown, projectId: string, receivedAt: Date, eventId: string, version = 'v1:') {
  const result = normalizeEvent(input, { projectId, receivedAt });
  if (result.ok) result.row.event_id = eventId;
  return result.ok ? (version.startsWith('v1:') ? eventFingerprint(result.row) : legacyEventFingerprint(result.row)) : null;
}

export type EventIdentity = { fingerprint: string; legacyFingerprint: string; receivedAt: Date; eventAt: Date };
export const matchesIdentity = (fingerprint: string, identity: EventIdentity) =>
  fingerprint === (fingerprint.startsWith('v1:') ? identity.fingerprint : identity.legacyFingerprint);

/** No time restriction: an id is unique across the entire project, including different partitions. */
export async function existingEventIdentities(ch: ClickHouseClient, projectId: string, ids: string[]) {
  if (!ids.length) return new Map<string, EventIdentity>();
  const hits = await read<{ event_id: string; timestamp: string }>(
    ch,
    'SELECT event_id,timestamp FROM event_ids WHERE project_id={project:String} AND event_id IN {ids:Array(String)}',
    { project: projectId, ids },
  );
  if (!hits.length) return new Map<string, EventIdentity>();
  const rows = await read<Pick<EventRow, 'event_id' | 'received_at' | 'payload'>>(
    ch,
    'SELECT event_id,received_at,payload FROM events WHERE project_id={project:String} AND (timestamp,event_id) IN arrayZip({timestamps:Array(DateTime64(3))},{hitIds:Array(String)}) ORDER BY received_at,timestamp,event_id LIMIT 1 BY event_id',
    { project: projectId, timestamps: hits.map((hit) => hit.timestamp), hitIds: hits.map((hit) => hit.event_id) },
  );
  return new Map(
    rows.map((row) => {
      const receivedAt = new Date(row.received_at.endsWith('Z') ? row.received_at : `${row.received_at.replace(' ', 'T')}Z`);
      // Re-normalize to avoid materialized columns and ClickHouse date serialization in the digest.
      const normalized = normalizeEvent(JSON.parse(row.payload), { projectId, receivedAt });
      if (!normalized.ok) throw new Error('Stored event cannot be normalized');
      normalized.row.event_id = row.event_id;
      return [
        row.event_id,
        {
          fingerprint: eventFingerprint(normalized.row),
          legacyFingerprint: legacyEventFingerprint(normalized.row),
          receivedAt,
          eventAt: new Date(normalized.row.timestamp),
        },
      ];
    }),
  );
}
