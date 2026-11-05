import { insertEvents, normalizeEvent, rebuildProjectRollups } from '@trailmark/clickhouse';
import { SAMPLE_DATA_EVENTS, SAMPLE_DATA_SOURCE } from '@trailmark/contracts';
import { clickhouse } from './clickhouse';

/** Caller holds the same cross-process project lock as ingestion and retention. */
export async function removeSampleData(projectId: string) {
  await clickhouse.command({
    query: 'DELETE FROM events WHERE project_id={p:String} AND source={source:String}',
    query_params: { p: projectId, source: SAMPLE_DATA_SOURCE },
    clickhouse_settings: { mutations_sync: '2', lightweight_deletes_sync: '2' },
  });
  await rebuildProjectRollups(clickhouse, projectId);
}
export async function loadSampleData(projectId: string) {
  await removeSampleData(projectId);
  const now = Date.now();
  const actors = ['Lina Haddad', 'Omar Nasser', 'Sara Mansour', 'Yusuf Kareem'];
  const tenants = ['Cedar Courtyard', 'Palm Lantern', 'Saffron Suites'];
  const actions = ['reservation.created', 'reservation.confirmed', 'invoice.issued', 'payment.processed', 'room.updated'];
  const rows = Array.from({ length: SAMPLE_DATA_EVENTS }, (_, i) => {
    const occurredAt = new Date(now - ((SAMPLE_DATA_EVENTS - 1 - i) / SAMPLE_DATA_EVENTS) * 7 * 86_400_000);
    const action = actions[i % actions.length];
    const event = normalizeEvent(
      {
        action,
        occurredAt: occurredAt.toISOString(),
        source: SAMPLE_DATA_SOURCE,
        actor: { id: `sample-user-${i % 4}`, type: 'user', name: actors[i % 4] },
        tenant: { id: `sample-tenant-${i % 3}`, name: tenants[i % 3] },
        executor: { id: i % 3 ? 'reservation-api' : 'billing-worker', type: i % 3 ? 'api' : 'worker' },
        targets: [{ type: 'reservation', id: `sample-reservation-${Math.floor(i / 5)}`, name: `Reservation ${1000 + Math.floor(i / 5)}` }],
        outcome: i % 17 === 0 ? 'failure' : 'success',
        severity: i % 17 === 0 ? 'warning' : 'info',
        description: `${actors[i % 4]} ${action?.replace('.', ' ')} at ${tenants[i % 3]}`,
        context: { operationId: `sample-operation-${Math.floor(i / 5)}` },
        changes: [{ field: 'status', before: 'pending', after: i % 17 === 0 ? 'failed' : 'confirmed' }],
        metadata: { channel: i % 2 ? 'web' : 'mobile' },
      },
      { projectId, receivedAt: occurredAt, sdk: 'trailmark-sample' },
    );
    if (!event.ok) throw new Error(event.reason);
    return event.row;
  });
  await insertEvents(clickhouse, rows);
  return { inserted: rows.length };
}
