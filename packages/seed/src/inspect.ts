import { createClickHouseClient, entityProfile, facets, operationEvents, overview, searchEvents } from '@trailmark/clickhouse';

// Deliberately restricted local acceptance receipt; never reads other projects.
if (process.env.CLICKHOUSE_DATABASE !== 'trailmark') throw new Error('Expected local trailmark database');
const ch = createClickHouseClient();
const range = { from: new Date(Date.now() - 61 * 86_400_000).toISOString(), to: new Date().toISOString() };
try {
  for (const project of ['seed-staydesk-dev', 'seed-ledger-dev']) {
    const summary = await overview(ch, project, range);
    console.log(JSON.stringify({ project, kpis: summary.kpis, topActions: summary.topActions.slice(0, 5) }));
    const actions = await facets(ch, project, { ...range, field: 'action', limit: 200 });
    console.log(JSON.stringify({ project, vocabulary: actions.values.length }));
    const samples = await searchEvents(ch, project, {
      ...range,
      q: project.includes('ledger') ? 'action:vendor.bank_details.changed' : 'action:hotel.policy.updated',
      limit: 3,
      order: 'desc',
    });
    console.log(
      JSON.stringify({ project, samples: samples.data.map((e) => ({ action: e.action, description: e.description, changes: e.changes })) }),
    );
    const roots = await searchEvents(ch, project, {
      ...range,
      q: project.includes('ledger') ? 'action:invoice.approval.requested executor.type:api' : 'action:crm.sync.requested executor.type:api',
      limit: 1,
      order: 'desc',
    });
    const op = roots.data[0]?.context.operationId;
    if (op)
      console.log(
        JSON.stringify({
          project,
          operation: op,
          tree: (await operationEvents(ch, project, op)).map((e) => ({
            id: e.id,
            parent: e.context.parentEventId,
            action: e.action,
            actor: e.actor?.name,
            executor: e.executor?.type,
            attempt: e.executor?.attempt,
            outcome: e.outcome,
          })),
        }),
      );
    const profile = await entityProfile(ch, project, 'tenant', 'biz_1', range);
    console.log(JSON.stringify({ project, entity: profile?.entity, topActions: profile?.topActions.slice(0, 3) }));
  }
} finally {
  await ch.close();
}
