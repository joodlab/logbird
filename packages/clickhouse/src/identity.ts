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

/** Compare normalized content; JSON key order, raw formatting and transport SDK are not identity. */
export function eventFingerprint(row: EventRow) {
  const { received_at: _received, payload: _payload, sdk: _sdk, ...content } = row;
  return createHash('sha256')
    .update(JSON.stringify(sorted(content)))
    .digest('hex');
}

/** Use the first receipt's clock so omitted/invalid occurredAt stays idempotent on later retries. */
export function retryFingerprint(input: unknown, projectId: string, receivedAt: Date, eventId: string) {
  const result = normalizeEvent(input, { projectId, receivedAt });
  if (result.ok) result.row.event_id = eventId;
  return result.ok ? eventFingerprint(result.row) : null;
}

/** No time restriction: an id is unique across the entire project, including different partitions. */
export async function existingEventIdentities(ch: ClickHouseClient, projectId: string, ids: string[]) {
  if (!ids.length) return new Map<string, { fingerprint: string; receivedAt: Date; eventAt: Date }>();
  const rows = await read<EventRow>(
    ch,
    'SELECT * EXCEPT(category,search_text) FROM events WHERE project_id={project:String} AND event_id IN {ids:Array(String)} ORDER BY received_at,timestamp,event_id LIMIT 1 BY event_id',
    { project: projectId, ids },
  );
  return new Map(
    rows.map((row) => {
      const receivedAt = new Date(row.received_at.endsWith('Z') ? row.received_at : `${row.received_at.replace(' ', 'T')}Z`);
      // Re-normalize to avoid materialized columns and ClickHouse date serialization in the digest.
      const normalized = normalizeEvent(JSON.parse(row.payload), { projectId, receivedAt });
      if (!normalized.ok) throw new Error('Stored event cannot be normalized');
      normalized.row.event_id = row.event_id;
      return [row.event_id, { fingerprint: eventFingerprint(normalized.row), receivedAt, eventAt: new Date(normalized.row.timestamp) }];
    }),
  );
}
