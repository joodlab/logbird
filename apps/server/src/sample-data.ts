import { insertEvents, normalizeEvent, rebuildProjectRollups } from '@logbird/clickhouse';
import { SAMPLE_DATA_EVENTS, SAMPLE_DATA_SOURCE, SAMPLE_DATA_SOURCES } from '@logbird/contracts';
import { prisma } from '@logbird/database';
import { clickhouse } from './clickhouse';

/** Caller holds the same cross-process project lock as ingestion and retention. */
export async function removeSampleData(projectId: string) {
  await prisma.project.update({ where: { id: projectId }, data: { exportGeneration: { increment: 1 } } });
  await clickhouse.command({
    query: 'DELETE FROM events WHERE project_id={p:String} AND source IN {source:Array(String)}',
    query_params: { p: projectId, source: SAMPLE_DATA_SOURCES },
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
    const reservation = Math.floor(i / 5);
    const step = i % 5;
    const retry = reservation % 17 === 0;
    const failed = retry && step === 3;
    const action = retry && step === 4 ? 'payment.processed' : actions[step];
    const actor = actors[reservation % actors.length];
    const tenant = tenants[reservation % tenants.length];
    const worker = step >= 2 && (step < 4 || retry);
    const changes = [
      { field: 'status', after: 'pending' },
      { field: 'status', before: 'pending', after: 'confirmed' },
      { field: 'invoice.status', before: 'draft', after: 'issued' },
      { field: 'payment.status', before: 'pending', after: failed ? 'failed' : 'paid' },
      retry ? { field: 'payment.status', before: 'failed', after: 'paid' } : { field: 'availability', before: 'available', after: 'reserved' },
    ];
    const event = normalizeEvent(
      {
        action,
        occurredAt: occurredAt.toISOString(),
        source: SAMPLE_DATA_SOURCE,
        actor: { id: `sample-user-${reservation % actors.length}`, type: 'user', name: actor },
        tenant: { id: `sample-tenant-${reservation % tenants.length}`, name: tenant },
        executor: {
          id: worker ? 'billing-worker' : 'reservation-api',
          type: worker ? 'worker' : 'api',
          ...(worker ? { jobId: `sample-billing-${reservation}`, attempt: retry && step === 4 ? 2 : 1 } : {}),
        },
        targets:
          step === 4 && !retry
            ? [{ type: 'room', id: `sample-room-${reservation}`, name: `Room ${reservation}` }]
            : [{ type: 'reservation', id: `sample-reservation-${reservation}`, name: `Reservation ${reservation}` }],
        outcome: failed ? 'failure' : 'success',
        severity: failed ? 'warning' : 'info',
        description: `${actor} ${action?.replace('.', ' ')} at ${tenant}`,
        context: { operationId: `sample-operation-${reservation}`, ...(step ? { parentEventId: `sample-event-${i - 1}` } : {}) },
        id: `sample-event-${i}`,
        changes: [changes[step]],
        metadata: { channel: i % 2 ? 'web' : 'mobile' },
      },
      { projectId, receivedAt: occurredAt, sdk: 'logbird-sample' },
    );
    if (!event.ok) throw new Error(event.reason);
    return event.row;
  });
  await insertEvents(clickhouse, rows);
  return { inserted: rows.length };
}
