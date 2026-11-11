import { createHash } from 'node:crypto';
import type { ClickHouseClient } from './client';
import { projectMaintenance } from './maintenance-tag';
import { type EventRow, normalizeEvent } from './normalize';
import { deleteAndVerify, read } from './queries';
import { resolveTimestamp } from './timestamp';

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
const digest = (value: unknown) =>
  createHash('sha256')
    .update(JSON.stringify(sorted(value)))
    .digest('hex');
const iso = (value: string) => new Date(value.endsWith('Z') ? value : `${value.replace(' ', 'T')}Z`);
// Frozen normalized fields from 3a1541f. Materialized and future search fields never enter the old digest.
const legacyFields = [
  'project_id',
  'event_id',
  'timestamp',
  'action',
  'environment',
  'outcome',
  'severity',
  'description',
  'actor_type',
  'actor_id',
  'actor_name',
  'actor_email',
  'impersonator_id',
  'impersonator_name',
  'executor_type',
  'executor_id',
  'executor_name',
  'job_id',
  'job_attempt',
  'tenant_id',
  'tenant_name',
  'source',
  'target_types',
  'target_ids',
  'target_names',
  'changes_fields',
  'changes_before',
  'changes_after',
  'operation_id',
  'parent_event_id',
  'request_id',
  'trace_id',
  'ip',
  'user_agent',
  'conformance',
  'schema_version',
  'attributes',
] as const satisfies readonly (keyof EventRow)[];
export function legacyEventFingerprint(row: EventRow) {
  return digest(Object.fromEntries(legacyFields.map((key) => [key, row[key]])));
}
export function canonicalFingerprint(input: unknown, timestamp: string) {
  return `v1:${digest({ input, timestamp })}`;
}
/** v1 hashes parsed input and resolved time, never search columns or admission rules. */
export function eventFingerprint(row: EventRow) {
  return canonicalFingerprint(JSON.parse(row.payload), row.timestamp);
}
export function retryFingerprint(input: unknown, projectId: string, receivedAt: Date, eventId: string, expected = 'v1:', eventAt?: Date) {
  if (expected.startsWith('unreadable:')) return null;
  if (expected.startsWith('v1:')) {
    const occurredAt = input && typeof input === 'object' ? (input as Record<string, unknown>).occurredAt : undefined;
    return canonicalFingerprint(input, (eventAt ?? resolveTimestamp(occurredAt, receivedAt).timestamp).toISOString());
  }
  const result = normalizeEvent(input, { projectId, receivedAt });
  if (!result.ok) return null;
  result.row.event_id = eventId;
  return legacyEventFingerprint(result.row);
}
export type EventIdentity = { fingerprint: string; legacyFingerprint: string; receivedAt: Date; eventAt: Date };
export const matchesIdentity = (fingerprint: string, identity: EventIdentity) =>
  fingerprint === (fingerprint.startsWith('v1:') ? identity.fingerprint : identity.legacyFingerprint);

function identities(rows: EventRow[]) {
  return new Map(
    rows.map((row) => {
      const receivedAt = iso(row.received_at),
        eventAt = iso(row.timestamp);
      const normalized = { ...row, timestamp: eventAt.toISOString() };
      let fingerprint: string;
      try {
        fingerprint = canonicalFingerprint(JSON.parse(row.payload), eventAt.toISOString());
      } catch {
        fingerprint = `unreadable:${digest({ payload: row.payload, timestamp: eventAt.toISOString() })}`;
      }
      return [row.event_id, { fingerprint, legacyFingerprint: legacyEventFingerprint(normalized), receivedAt, eventAt }];
    }),
  );
}
/** Cold reconciliation reads authoritative raw evidence, even when an MV never populated the index. */
export async function rawEventIdentities(ch: ClickHouseClient, projectId: string, ids: string[]) {
  if (!ids.length) return new Map<string, EventIdentity>();
  return identities(
    await read<EventRow>(
      ch,
      'SELECT * EXCEPT(category,search_text) FROM events WHERE project_id={project:String} AND event_id IN {ids:Array(String)} ORDER BY received_at,timestamp,event_id LIMIT 1 BY event_id',
      { project: projectId, ids },
    ),
  );
}
/** Fresh misses stay narrow. Payload reads happen only for index hits; dangling pointers fall back per id. */
export async function existingEventIdentities(ch: ClickHouseClient, projectId: string, ids: string[]) {
  if (!ids.length) return new Map<string, EventIdentity>();
  const hits = await read<{ event_id: string; timestamp: string; received_at: string }>(
    ch,
    'SELECT event_id,timestamp,received_at FROM event_ids WHERE project_id={project:String} AND event_id IN {ids:Array(String)} ORDER BY received_at,timestamp,event_id LIMIT 1 BY event_id',
    { project: projectId, ids },
  );
  if (!hits.length) return new Map<string, EventIdentity>();
  const found = identities(
    await read<EventRow>(
      ch,
      'SELECT * EXCEPT(category,search_text) FROM events WHERE project_id={project:String} AND (timestamp,event_id) IN arrayZip({timestamps:Array(DateTime64(3))},{hitIds:Array(String)}) AND (timestamp,event_id,received_at) IN arrayZip({timestamps:Array(DateTime64(3))},{hitIds:Array(String)},{received:Array(DateTime64(3))}) ORDER BY received_at,timestamp,event_id LIMIT 1 BY event_id',
      {
        project: projectId,
        timestamps: hits.map((hit) => hit.timestamp),
        hitIds: hits.map((hit) => hit.event_id),
        received: hits.map((hit) => hit.received_at),
      },
    ),
  );
  const missing = [...new Set(hits.map((hit) => hit.event_id))].filter((id) => !found.has(id));
  for (const [id, identity] of await rawEventIdentities(ch, projectId, missing)) found.set(id, identity);
  return found;
}
/** Caller holds the exclusive project lock. Keep every surviving raw identity protected. */
export async function repairEventIndex(client: ClickHouseClient, projectId: string, ids: string[], stored: Map<string, EventIdentity>) {
  const ch = projectMaintenance(client, projectId);
  const absent = ids.filter((id) => !stored.has(id));
  if (stored.size)
    await ch.insert({
      table: 'event_ids',
      format: 'JSONEachRow',
      values: [...stored].map(([event_id, identity]) => ({
        project_id: projectId,
        event_id,
        received_at: identity.receivedAt.toISOString(),
        timestamp: identity.eventAt.toISOString(),
      })),
    });
  // A stale pointer only costs a raw-row fallback lookup (existingEventIdentities), so it must not block recovery:
  // valid pointers are written first, and a delete that stays visible (restored parts) is reported, not thrown.
  if (absent.length)
    try {
      await deleteAndVerify(ch, projectId, 'event_ids', 'event_id IN {ids:Array(String)}', { ids: absent }, { logIncomplete: false });
    } catch (error) {
      if ((error as { code?: string })?.code !== 'LOGBIRD_DELETE_INCOMPLETE') throw error;
      console.warn(JSON.stringify({ level: 'warn', event: 'clickhouse.event_index_stale_pointers', projectId, count: absent.length }));
    }
}
