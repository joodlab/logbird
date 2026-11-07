import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { insertEvents, normalizeEvent, read, searchEvents, toEvent, where } from '@logbird/clickhouse';
import { closeProjectLocks, prisma, withProjectLock } from '@logbird/database';
import { clickhouse, purgeProjectEvents } from '../apps/server/src/clickhouse';

// Opt-in benchmark. Hold BOTH heavy and logbird-stack slots; check RAM before running.
// 1M receipts, paired 1000-event INSERTs and explorer queries over 10M owned history rows.
// Supply the cloud load owner's approved fictional source project. It is read, never modified.
const historySource = process.argv[2];
const expectedHead = process.argv[3];
const variant = process.argv[4] ?? 'baseline';
if (!['baseline', 'immutable'].includes(variant)) throw new Error('Variant must be baseline or immutable');
const immutableWriter = existsSync(new URL('../apps/server/src/immutable-ingest.ts', import.meta.url));
if ((variant === 'immutable') !== immutableWriter) throw new Error('Variant does not match the checked-out writer');
const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (!historySource || !expectedHead)
  throw new Error(
    'Usage: node --env-file=.env --import tsx scripts/benchmark-ingest-identity.ts APPROVED_10M_SOURCE_PROJECT EXPECTED_HEAD [baseline|immutable]',
  );
if (head !== expectedHead || execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).trim())
  throw new Error('Benchmark requires a clean checkout at EXPECTED_HEAD');
console.log(JSON.stringify({ head, variant, historySource, startedAt: new Date().toISOString() }));
const org = randomUUID();
const table = `qa_receipts_${org.replaceAll('-', '')}`;
const project = `qa-identity-${org}`;
const logComment = `immutable-benchmark-${org}`;
process.env.BULLMQ_PREFIX = `{logbird-benchmark-${org}}`;
const { ingest } = await import('../apps/server/src/ingest');
const { rateLimitStore } = await import('../apps/server/src/rate-limit');
const { closeRetentionQueue } = await import('../apps/worker/src/queue');
console.log(JSON.stringify({ fixture: { org, project, table } }));
let queryLabel = 'setup';
const query = clickhouse.query.bind(clickhouse);
clickhouse.query = (params) =>
  query({ ...params, clickhouse_settings: { ...params.clickhouse_settings, log_comment: `${logComment}:${queryLabel}` } });
const batchSize = 1000;
const p95 = (samples: number[]) => [...samples].sort((a, b) => a - b)[Math.ceil(samples.length * 0.95) - 1];
const p50 = (samples: number[]) => [...samples].sort((a, b) => a - b)[Math.ceil(samples.length * 0.5) - 1];
const timed = async (work: () => Promise<unknown>) => {
  const start = performance.now();
  await work();
  return performance.now() - start;
};
try {
  const sourceRows = await read<{ n: number }>(clickhouse, 'SELECT count() n FROM events WHERE project_id={p:String}', { p: historySource });
  if (Number(sourceRows[0]?.n) < 10_000_000) throw new Error('Approved source must have at least 10M rows');
  await prisma.organization.create({ data: { id: org, name: 'QA Immutable benchmark', slug: org, createdAt: new Date() } });
  await prisma.project.create({ data: { id: project, organizationId: org, name: 'QA Immutable benchmark', slug: project, retentionDays: 3650 } });
  // All identifiers are generated here, never accepted from CLI/environment.
  await prisma.$executeRawUnsafe(`CREATE TABLE ${table} (LIKE "IngestReceipt" INCLUDING ALL)`);
  await prisma.$executeRawUnsafe(`ALTER TABLE ${table} ADD FOREIGN KEY ("organizationId") REFERENCES "organization"(id)`);
  const claims: number[] = [];
  for (let batch = 0; batch < 1000; batch++) {
    const ids = Array.from({ length: batchSize }, () => randomUUID());
    claims.push(
      await timed(() =>
        prisma.$queryRawUnsafe(
          `INSERT INTO ${table}
      ("projectId","eventId","organizationId","fingerprint","receivedAt","eventAt","confirmedAt")
      SELECT $1,id,$2,'v1:' || repeat('f',64),now(),now(),now() FROM unnest($3::text[]) id
      ON CONFLICT ("projectId","eventId") DO NOTHING RETURNING "eventId"`,
          project,
          org,
          ids,
        ),
      ),
    );
    if ((batch + 1) % 100 === 0) console.log(JSON.stringify({ receiptRows: (batch + 1) * batchSize }));
  }
  const size = await prisma.$queryRawUnsafe(`SELECT pg_relation_size('${table}')::float8 heap_bytes,
    pg_table_size('${table}')::float8 table_bytes,pg_indexes_size('${table}')::float8 index_bytes,
    pg_total_relation_size('${table}')::float8 total_bytes`);
  await prisma.$executeRawUnsafe(`DROP TABLE ${table}`);
  await clickhouse.command({
    query:
      'INSERT INTO events SELECT {project:String},* EXCEPT(project_id,category,search_text) FROM events WHERE project_id={source:String} LIMIT 10000000',
    query_params: { project, source: historySource },
    clickhouse_settings: { max_execution_time: 300 },
  });
  const historyRows = (await read<{ n: number }>(clickhouse, 'SELECT count() n FROM events WHERE project_id={p:String}', { p: project }))[0]?.n;
  if (Number(historyRows) < 10_000_000) throw new Error('Owned benchmark history must have at least 10M rows');
  for (const { batchSize, payloadBytes } of [
    { batchSize: 1, payloadBytes: 0 },
    { batchSize: 100, payloadBytes: 0 },
    { batchSize: 1000, payloadBytes: 0 },
    { batchSize: 1000, payloadBytes: 4096 },
  ]) {
    const rawMs: number[] = [],
      fencedMs: number[] = [],
      addedMs: number[] = [];
    for (let batch = 0; batch < 21; batch++) {
      const now = new Date();
      const candidates = Array.from({ length: batchSize }, () => {
        const input = {
          id: randomUUID(),
          action: 'benchmark.immutable',
          occurredAt: now.toISOString(),
          actor: { id: 'fictional' },
          ...(payloadBytes ? { metadata: { content: 'x'.repeat(payloadBytes) } } : {}),
        };
        const normalized = normalizeEvent(input, { projectId: project, receivedAt: now });
        if (!normalized.ok) throw new Error('Invalid fixture');
        return { input, row: normalized.row };
      });
      // Distinct ids in the same retained-history project: both paths measure fresh writes.
      const rawRows = candidates.map(({ row, input }) => {
        const id = randomUUID();
        return { ...row, event_id: id, payload: JSON.stringify({ ...input, id }) };
      });
      const raw = () => {
        queryLabel = `ingest-${batchSize}-${batch}-raw`;
        return withProjectLock(project, () => insertEvents(clickhouse, rawRows), { mode: 'shared' });
      };
      const fenced = async () => {
        queryLabel = `ingest-${batchSize}-${payloadBytes}-${batch}-${variant}`;
        await ingest(
          project,
          candidates.map((c) => c.input),
        );
      };
      let rawTime: number, fencedTime: number;
      if (batch % 2 === 0) {
        rawTime = await timed(raw);
        fencedTime = await timed(fenced);
      } else {
        fencedTime = await timed(fenced);
        rawTime = await timed(raw);
      }
      if (batch) {
        rawMs.push(rawTime);
        fencedMs.push(fencedTime);
        addedMs.push(fencedTime - rawTime);
      }
    }
    console.log(
      JSON.stringify({
        variant,
        payloadBytes,
        receiptRows: 1_000_000,
        historyRows,
        batchSize,
        receiptBulkClaimP95Ms: p95(claims),
        size,
        samples: rawMs.length,
        rawP95Ms: p95(rawMs),
        rawP50Ms: p50(rawMs),
        ingestP95Ms: p95(fencedMs),
        ingestP50Ms: p50(fencedMs),
        pairedAddedP95Ms: p95(addedMs),
        pairedAddedP50Ms: p50(addedMs),
        rawMs,
        ingestMs: fencedMs,
        addedMs,
      }),
    );
  }
  const bounds = (
    await read<{ first: string; last: string }>(
      clickhouse,
      'SELECT min(timestamp) first,max(timestamp) last FROM events WHERE project_id={p:String}',
      { p: project },
    )
  )[0];
  if (!bounds) throw new Error('Missing benchmark bounds');
  const iso = (value: string) => new Date(value.endsWith('Z') ? value : `${value.replace(' ', 'T')}Z`);
  const last = iso(bounds.last).getTime();
  for (const range of ['day', 'full'] as const)
    for (const order of ['asc', 'desc'] as const) {
      const q = {
        from: range === 'day' ? new Date(last - 86_400_000).toISOString() : iso(bounds.first).toISOString(),
        to: new Date(last + 1000).toISOString(),
        limit: 200,
        order,
      };
      const filter = await where(clickhouse, project, q);
      const direction = order.toUpperCase();
      const before: number[] = [],
        after: number[] = [];
      const legacy = async () => {
        const rows = await read<Parameters<typeof toEvent>[0]>(
          clickhouse,
          `SELECT * EXCEPT(payload,search_text) FROM events WHERE project_id={project:String} AND (timestamp,event_id) IN
        (SELECT timestamp,event_id FROM events WHERE ${filter.sql} ORDER BY timestamp ${direction},event_id ${direction} LIMIT 1 BY timestamp,event_id LIMIT {limit:UInt32})
        ORDER BY timestamp ${direction},event_id ${direction} LIMIT 1 BY timestamp,event_id`,
          { ...filter.params, limit: 201 },
        );
        rows.slice(0, 200).map(toEvent);
        await read(clickhouse, `SELECT count() n FROM (SELECT DISTINCT event_id FROM events WHERE ${filter.sql} LIMIT 10001)`, filter.params, 1);
      };
      for (let sample = 0; sample < 21; sample++) {
        let oldMs: number, newMs: number;
        if (sample % 2 === 0) {
          queryLabel = `explorer-${range}-${order}-${sample}-legacy`;
          oldMs = await timed(legacy);
          queryLabel = `explorer-${range}-${order}-${sample}-current`;
          newMs = await timed(() => searchEvents(clickhouse, project, q));
        } else {
          queryLabel = `explorer-${range}-${order}-${sample}-current`;
          newMs = await timed(() => searchEvents(clickhouse, project, q));
          queryLabel = `explorer-${range}-${order}-${sample}-legacy`;
          oldMs = await timed(legacy);
        }
        if (sample) {
          before.push(oldMs);
          after.push(newMs);
        }
      }
      console.log(
        JSON.stringify({
          explorer: {
            range,
            order,
            historyRows,
            samples: before.length,
            beforeP50Ms: p50(before),
            beforeP95Ms: p95(before),
            afterP50Ms: p50(after),
            afterP95Ms: p95(after),
            before,
            after,
          },
        }),
      );
    }
  await clickhouse.command({ query: 'SYSTEM FLUSH LOGS' });
  const queryWork = await read(
    clickhouse,
    "SELECT log_comment,query_id,query_duration_ms,read_rows,read_bytes,result_rows,memory_usage FROM system.query_log WHERE type='QueryFinish' AND startsWith(log_comment,{tag:String}) ORDER BY event_time_microseconds",
    { tag: logComment },
  );
  console.log(JSON.stringify({ head, queryWork }));
} finally {
  // Master's purge may predate event_ids even when the shared DB already has the additive index.
  const indexExists = Number((await read<{ result: number }>(clickhouse, 'EXISTS TABLE event_ids'))[0]?.result ?? 0) === 1;
  for (const owned of [project])
    await withProjectLock(owned, async () => {
      await purgeProjectEvents(owned);
      if (indexExists)
        await clickhouse.command({
          query: 'DELETE FROM event_ids WHERE project_id={p:String}',
          query_params: { p: owned },
          clickhouse_settings: { mutations_sync: '2', lightweight_deletes_sync: '2' },
        });
    });
  await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS ${table}`);
  await prisma.organization.deleteMany({ where: { id: org } });
  await rateLimitStore.quit();
  await closeRetentionQueue();
  await clickhouse.close();
  await closeProjectLocks();
  await prisma.$disconnect();
}
