import type { ClickHouseClient, ClickHouseSettings } from '@clickhouse/client';
import { CLICKHOUSE_PLAIN_READ } from './client';
import { projectMaintenance } from './maintenance-tag';
import { rollupSql } from './rollup-sql';

/**
 * The hourly retention run without holding the project lock across ClickHouse mutations (#268).
 *
 * A lightweight DELETE becomes a mutation that ClickHouse applies to every active part of the table, one background
 * task per part: tens of seconds on a large table. The run therefore never waits for one under the lock. Two short
 * exclusive fences bound it (apps/worker/src/retention.ts holds them); this module is the ClickHouse side:
 *
 * - Fence A records F_A (database clock, ms) after every insert accepted before it has landed. The rows this run
 *   deletes are exactly `timestamp < cutoff AND received_at <= F_A`; anything received later survives this run.
 * - Between the fences, without a lock: the affected rollup keys (entities, attribute keys) and their recomputed rows
 *   from the surviving rows received by F_A are staged in a session temporary table (the expensive part).
 * - Fence B (F_B): the DELETE mutations are created without waiting, then the staged rows and a small delta for rows
 *   received in (F_A, F_B] are inserted. A mutation applies only to parts that existed when it was created, so the
 *   recomputed rows and every insert after the fence survive it, while every older rollup row of an affected key is
 *   removed. Readers apply pending mutations on the fly, so they never see the old and the new rows together.
 * - The cutoff is floored to the minute, so every `events_by_minute` bucket below it held only expired rows plus any
 *   delta: those buckets are deleted and only the delta is re-inserted.
 */

const ms = (d: Date) => d.toISOString().replace('T', ' ').slice(0, -1);
// Parameters are bound exactly as given (UTC `YYYY-MM-DD hh:mm:ss.sss`), never re-parsed in the local time zone.
async function rows<T>(ch: ClickHouseClient, query: string, query_params: Record<string, unknown>, settings?: ClickHouseSettings) {
  return (await (await ch.query({ query, query_params, format: 'JSONEachRow', clickhouse_settings: settings })).json()) as T[];
}
const STAGE_TABLES = { entities: 'retention_stage_entities', attribute_keys: 'retention_stage_attribute_keys' } as const;
type Staged = keyof typeof STAGE_TABLES;

/** Floors a retention cutoff to the minute, so the minute rollups split cleanly at it. */
export const retentionCutoff = (now: number, retentionDays: number) => new Date(Math.floor((now - retentionDays * 86_400_000) / 60_000) * 60_000);

export type RetentionKeys = { kinds: string[]; entityIds: string[]; keys: string[] };
const deleted = '(timestamp < {cutoff:DateTime64(3)} AND received_at <= {fenceA:DateTime64(3)})';

/** The rollup keys the rows this run deletes contributed to. */
export async function retentionAffectedKeys(ch: ClickHouseClient, p: string, cutoff: Date, fenceA: Date): Promise<RetentionKeys> {
  const found = await rows<{ kind: string; id: string }>(
    projectMaintenance(ch, p),
    `SELECT DISTINCT kind,id FROM (
    SELECT 'actor' kind,actor_id id FROM events WHERE project_id={p:String} AND ${deleted} AND actor_id!=''
    UNION ALL SELECT 'tenant',tenant_id FROM events WHERE project_id={p:String} AND ${deleted} AND tenant_id!=''
    UNION ALL SELECT 'executor',executor_id FROM events WHERE project_id={p:String} AND ${deleted} AND executor_id!=''
    UNION ALL SELECT 'target',concat(t.1,':',t.2) FROM events ARRAY JOIN arrayZip(target_types,target_ids) AS t WHERE project_id={p:String} AND ${deleted}
    UNION ALL SELECT 'attribute',arrayJoin(mapKeys(attributes)) FROM events WHERE project_id={p:String} AND ${deleted})`,
    { p, cutoff: ms(cutoff), fenceA: ms(fenceA) },
  );
  const entities = found.filter((r) => r.kind !== 'attribute');
  return {
    kinds: entities.map((r) => r.kind),
    entityIds: entities.map((r) => r.id),
    keys: found.filter((r) => r.kind === 'attribute').map((r) => r.id),
  };
}

/** How many raw rows this run deletes (reported on the run). */
export async function retentionDeletedCount(ch: ClickHouseClient, p: string, cutoff: Date, fenceA: Date) {
  const counted = await rows<{ n: number }>(projectMaintenance(ch, p), `SELECT count() n FROM events WHERE project_id={p:String} AND ${deleted}`, {
    p,
    cutoff: ms(cutoff),
    fenceA: ms(fenceA),
  });
  return Number(counted[0]?.n ?? 0);
}

const keyFilters = {
  events_by_minute: 'bucket < {cutoff:DateTime64(3)}',
  entities: '(kind,entity_id) IN arrayZip({kinds:Array(String)},{entityIds:Array(String)})',
  attribute_keys: 'key IN {keys:Array(String)}',
} as const;
type Rollup = keyof typeof keyFilters;

/** Each materialized view's SELECT, restricted to the project and to the rows `rowFilter` selects, then to the keys. */
function recomputeSelects(rowFilter: string) {
  const out: { table: Rollup; select: string }[] = [];
  for (const statement of rollupSql.split(';')) {
    const m = statement.match(/CREATE MATERIALIZED VIEW IF NOT EXISTS \w+ TO (\w+) AS (SELECT[\s\S]+)/);
    if (!m) continue;
    const table = m[1] as Rollup;
    const select = (m[2] as string).replace(
      /FROM events(.*?)(WHERE |GROUP BY )/s,
      (_all, join: string, clause: string) =>
        `FROM events${join}WHERE project_id={p:String} AND ${rowFilter} ${clause === 'WHERE ' ? 'AND ' : 'GROUP BY '}`,
    );
    out.push({ table, select: `SELECT * FROM (${select}) WHERE ${keyFilters[table]}` });
  }
  return out;
}

const params = (p: string, cutoff: Date, fenceA: Date, keys: RetentionKeys, fenceB?: Date) => ({
  p,
  cutoff: ms(cutoff),
  fenceA: ms(fenceA),
  ...(fenceB ? { fenceB: ms(fenceB) } : {}),
  ...keys,
});

/**
 * Between the fences, on a session client: recompute the affected entity and attribute-key rows from the rows that
 * survive this run and were received by F_A, into session temporary tables. Nothing visible changes.
 */
export async function stageRetentionRollups(session: ClickHouseClient, p: string, cutoff: Date, fenceA: Date, keys: RetentionKeys) {
  const ch = projectMaintenance(session, p);
  for (const [table, stage] of Object.entries(STAGE_TABLES)) {
    await ch.command({ query: `DROP TEMPORARY TABLE IF EXISTS ${stage}` });
    await ch.command({ query: `CREATE TEMPORARY TABLE ${stage} AS ${table}` });
  }
  const surviving = '(received_at <= {fenceA:DateTime64(3)} AND timestamp >= {cutoff:DateTime64(3)})';
  for (const { table, select } of recomputeSelects(surviving)) {
    if (!(table in STAGE_TABLES)) continue;
    await ch.command({ query: `INSERT INTO ${STAGE_TABLES[table as Staged]} ${select}`, query_params: params(p, cutoff, fenceA, keys) });
  }
}

const NO_WAIT = { mutations_sync: '0', lightweight_deletes_sync: '0' } as const;

/**
 * Fence B, under the exclusive project lock, on the session that staged the rows: create the five DELETE mutations
 * without waiting, then insert the staged rows and the delta for rows received in (F_A, F_B]. Order matters: the
 * inserts must be newer parts than the rollup DELETEs, or those DELETEs would remove them.
 */
export async function applyRetention(
  session: ClickHouseClient,
  p: string,
  cutoff: Date,
  fenceA: Date,
  fenceB: Date,
  keys: RetentionKeys,
  /** Test seam: runs after the DELETE mutations exist, before the replacement rows are inserted. */
  afterDeletes?: () => Promise<void>,
) {
  const ch = projectMaintenance(session, p);
  const bound = params(p, cutoff, fenceA, keys, fenceB);
  const deletes: [string, string][] = [
    ['events', deleted],
    ['event_ids', deleted],
    ['events_by_minute', keyFilters.events_by_minute],
  ];
  if (keys.entityIds.length) deletes.push(['entities', keyFilters.entities]);
  if (keys.keys.length) deletes.push(['attribute_keys', keyFilters.attribute_keys]);
  for (const [table, filter] of deletes)
    await ch.command({
      query: `DELETE FROM ${table} WHERE project_id={p:String} AND (${filter})`,
      query_params: bound,
      clickhouse_settings: NO_WAIT,
    });
  await afterDeletes?.();
  for (const [table, stage] of Object.entries(STAGE_TABLES)) await ch.command({ query: `INSERT INTO ${table} SELECT * FROM ${stage}` });
  // Rows received between the fences, whatever their timestamp, survive this run: their contribution comes back.
  const between = '(received_at > {fenceA:DateTime64(3)} AND received_at <= {fenceB:DateTime64(3)})';
  for (const { table, select } of recomputeSelects(between)) {
    if (table === 'entities' && !keys.entityIds.length) continue;
    if (table === 'attribute_keys' && !keys.keys.length) continue;
    await ch.command({ query: `INSERT INTO ${table} ${select}`, query_params: bound });
  }
}

/** The project's DELETE mutations that ClickHouse has not finished, with the reason any of them last failed. */
export async function pendingProjectMutations(ch: ClickHouseClient, p: string) {
  return rows<{ table: string; mutationId: string; created: string; failReason: string; failedAt: string | null }>(
    ch,
    `SELECT table, mutation_id mutationId, toString(create_time) created, latest_fail_reason failReason,
      if(latest_fail_time = toDateTime(0), NULL, toString(latest_fail_time)) failedAt
     FROM system.mutations WHERE database=currentDatabase() AND is_done=0
      AND table IN ('events','event_ids','events_by_minute','entities','attribute_keys')
      AND (position(command,{project:String})>0 OR position(command,{escaped:String})>0)
     ORDER BY create_time`,
    { project: p, escaped: p.replace(/[\\']/g, '\\$&') },
  );
}

/**
 * After the mutations finished: whether any row this run had to delete is still stored. A deliberate plain read
 * (pending mutations not applied), so it proves the parts themselves, not what readers are shown.
 */
export async function retentionRowsRemain(ch: ClickHouseClient, p: string, cutoff: Date, fenceA: Date) {
  const remaining = await rows<{ n: number }>(
    ch,
    `SELECT (SELECT count() FROM (SELECT 1 FROM events WHERE project_id={p:String} AND ${deleted} LIMIT 1))
      + (SELECT count() FROM (SELECT 1 FROM event_ids WHERE project_id={p:String} AND ${deleted} LIMIT 1)) n`,
    { p, cutoff: ms(cutoff), fenceA: ms(fenceA) },
    CLICKHOUSE_PLAIN_READ,
  );
  return Number(remaining[0]?.n ?? 0) > 0;
}
