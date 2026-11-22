/**
 * Scoped-read performance check (#138): p50/p95 of search, detail and facets for unscoped vs tenant-scoped reads on a
 * fictional multi-tenant project, including the worst case (a tiny tenant inside a large project).
 *
 *   node --env-file=../../.env --import tsx scripts/bench-scoped-read.ts [events=1000000] [runs=30]
 *
 * Rows are generated inside ClickHouse (INSERT … SELECT FROM numbers) in a dedicated `qa-bench-scoped-<uuid>`
 * project and purged afterwards, also on failure.
 */
import { randomUUID } from 'node:crypto';
import type { ReadScope } from '@logbird/contracts';
import { createClickHouseClient, exportEvents, facets, getEvent, purgeProject, searchEvents } from '../src/index';

const total = Number(process.argv[2] ?? 1_000_000);
const runs = Number(process.argv[3] ?? 30);
const ch = createClickHouseClient();
const p = `qa-bench-scoped-${randomUUID()}`;
const span = 7 * 86_400_000;
const step = Math.floor(span / total);

const stats = (times: number[]) => {
  const sorted = [...times].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] ?? 0;
  return { p50: Math.round(at(0.5) * 10) / 10, p95: Math.round(at(0.95) * 10) / 10 };
};
async function measure(name: string, run: () => Promise<unknown>) {
  await run(); // warm caches and the connection
  const times: number[] = [];
  for (let i = 0; i < runs; i++) {
    const start = performance.now();
    await run();
    times.push(performance.now() - start);
  }
  const result = { name, ...stats(times) };
  console.log(JSON.stringify(result));
  return result;
}

try {
  const started = performance.now();
  // ~60% one big tenant, 200 medium tenants, one tiny tenant with total/20000 events; 50 websites as targets.
  // 100k-row batches keep ClickHouse memory (rollup materialized views included) well under 1 GiB per statement.
  for (let offset = 0; offset < total; offset += 100_000)
    await ch.command({
      query: `INSERT INTO events (project_id,event_id,timestamp,received_at,action,description,actor_type,actor_id,actor_name,tenant_id,tenant_name,target_types,target_ids,target_names,operation_id,parent_event_id,attributes,payload)
      SELECT {p:String}, id, now64(3) - toIntervalMillisecond(number * {step:UInt64}), now64(3), act,
        'Fictional benchmark event', 'user', actor, 'Fictional user', tenant, 'Fictional tenant',
        ['website'], [site], ['Fictional site'],
        concat('op', toString(intDiv(number, 3))), if(number % 3 = 0, '', concat('bench-', toString(number - 1))),
        map('metadata.missing', missing),
        -- A realistic original document (~700 bytes): the scoped-read predicate checks tenant/target/action in it.
        concat('{"id":"', id, '","occurredAt":"2026-11-22T10:00:00.000Z","action":"', act, '","outcome":"success",',
          '"actor":{"type":"user","id":"', actor, '","name":"Fictional user","email":"', actor, '@example.invalid"},',
          '"tenant":{"id":"', tenant, '","name":"Fictional tenant"},"targets":[{"type":"website","id":"', site,
          '","name":"Fictional site"}],"context":{"ip":"203.0.113.10","userAgent":"Mozilla/5.0 (fictional benchmark agent)",',
          '"requestId":"req-', id, '","operationId":"op', toString(intDiv(number, 3)), '"},"metadata":{"missing":', missing,
          ',"note":"', repeat('fictional padding ', 18), '"}}')
      FROM (SELECT number, concat('bench-', toString(number)) id,
              arrayElement(['booking.created','booking.cancelled','auth.login','page.updated'], number % 4 + 1) act,
              concat('u', toString(number % 5000)) actor,
              multiIf(number % 20000 = 7, 'tiny', number % 10 < 6, 'big', concat('m', toString(number % 200))) tenant,
              concat('site_', toString(number % 50)) site,
              if(number % 3 = 0, '["roles:create"]', '["staff:invite","roles:create"]') missing
            FROM numbers({offset:UInt64}, {batch:UInt64}))`,
      query_params: { p, step, offset, batch: Math.min(100_000, total - offset) },
      clickhouse_settings: { max_insert_threads: '2', max_memory_usage: '1073741824' },
    });
  console.log(JSON.stringify({ project: p, inserted: total, seconds: Math.round((performance.now() - started) / 100) / 10 }));
  const now = Date.now();
  const day = { from: new Date(now - 86_400_000).toISOString(), to: new Date(now + 60_000).toISOString() };
  const week = { from: new Date(now - span - 60_000).toISOString(), to: day.to };
  const scopes: [string, ReadScope | null][] = [
    ['unscoped', null],
    ['big tenant', { tenantId: 'big' }],
    ['medium tenant', { tenantId: 'm16' }],
    ['tiny tenant', { tenantId: 'tiny' }],
    ['tiny tenant + website', { tenantId: 'tiny', target: { type: 'website', id: 'site_7' } }],
  ];
  const results: { name: string; p50: number; p95: number }[] = [];
  for (const [label, scope] of scopes) {
    for (const [range, r] of [
      ['24h', day],
      ['7d', week],
    ] as const) {
      results.push(await measure(`search ${range} ${label}`, () => searchEvents(ch, p, { ...r, limit: 50, order: 'desc' }, undefined, scope)));
    }
    results.push(await measure(`facets 7d action ${label}`, () => facets(ch, p, { ...week, field: 'action', limit: 10 }, scope)));
    results.push(
      await measure(`facets 7d attr×tenant ${label}`, () =>
        facets(ch, p, { ...week, field: 'attr.metadata.missing', by: 'tenant', limit: 10, byLimit: 5 }, scope),
      ),
    );
    // Detail of an event inside the scope (bench-7: tiny tenant on site_7; bench-2: big; bench-16: m16).
    const id = scope?.tenantId === 'tiny' ? 'bench-7' : scope?.tenantId === 'm16' ? 'bench-16' : 'bench-2';
    results.push(
      await measure(`detail ${label}`, async () => {
        if (!(await getEvent(ch, p, id, scope))) throw new Error(`detail ${id} missing for ${label}`);
      }),
    );
    // Full CSV export of the last hour (every page, every row), as GET /v1/export streams it.
    const hour = { from: new Date(now - 3_600_000).toISOString(), to: day.to };
    let rows = 0;
    results.push(
      await measure(`export 1h csv ${label}`, async () => {
        rows = 0;
        for await (const chunk of exportEvents(ch, p, { ...hour, q: '', format: 'csv' }, undefined, undefined, { scope })) rows += chunk.split('\n').length - 1;
      }),
    );
    console.log(JSON.stringify({ exportRows: label, rows }));
  }
  console.log(JSON.stringify({ summary: results }));
} finally {
  await purgeProject(ch, p);
  const left = await (
    await ch.query({ query: 'SELECT count() n FROM events WHERE project_id={p:String}', query_params: { p }, format: 'JSONEachRow' })
  ).json<{ n: number }>();
  console.log(JSON.stringify({ cleanup: p, remaining: Number(left[0]?.n ?? -1) }));
  await ch.close();
}
