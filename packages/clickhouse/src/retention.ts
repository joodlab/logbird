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

// Bounds are written as UTC wall-clock text and every placeholder is typed DateTime64(3,'UTC'), so a session time zone
// other than UTC cannot shift what retention selects, stages or deletes (#268).
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
const deleted = "(timestamp < {cutoff:DateTime64(3,'UTC')} AND received_at <= {fenceA:DateTime64(3,'UTC')})";

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
  events_by_minute: "bucket < {cutoff:DateTime64(3,'UTC')}",
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
    await ch.command({ query: `CREATE TEMPORARY TABLE ${stage} AS ${table}` });
  }
  const surviving = "(received_at <= {fenceA:DateTime64(3,'UTC')} AND timestamp >= {cutoff:DateTime64(3,'UTC')})";
  for (const { table, select } of recomputeSelects(surviving)) {
    if (!(table in STAGE_TABLES)) continue;
    await ch.command({ query: `INSERT INTO ${STAGE_TABLES[table as Staged]} ${select}`, query_params: params(p, cutoff, fenceA, keys) });
  }
}

/** Release staged rows on their session, even if staging failed partway through. */
export async function dropStagedRetentionRollups(session: ClickHouseClient) {
  for (const stage of Object.values(STAGE_TABLES)) {
    await session.command({ query: `DROP TEMPORARY TABLE IF EXISTS ${stage}` }).catch(() => undefined);
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
  const between = "(received_at > {fenceA:DateTime64(3,'UTC')} AND received_at <= {fenceB:DateTime64(3,'UTC')})";
  for (const { table, select } of recomputeSelects(between)) {
    if (table === 'entities' && !keys.entityIds.length) continue;
    if (table === 'attribute_keys' && !keys.keys.length) continue;
    await ch.command({ query: `INSERT INTO ${table} ${select}`, query_params: bound });
  }
}

/**
 * Functions Logbird's own mutation predicates use (literal-only DELETEs: `project_id = '…'`, `_CAST` timestamps,
 * `IN` lists, `arrayZip` pairs, `hasAny` in the demo cleanup). A pending mutation that calls anything else was created
 * outside Logbird.
 */
export const LOGBIRD_MUTATION_FUNCTIONS = new Set(['_CAST', 'arrayZip', 'hasAny', 'tuple']);
/**
 * Whether a mutation created outside Logbird is pending on a Logbird table. While one is, an on-the-fly read can fail
 * in ways that are not ours: the mutation cannot be applied on the fly, or its predicate errors when a read applies
 * it. Readers then answer 503 store_maintenance_blocking instead of a generic error.
 */
export async function foreignMutationPending(ch: ClickHouseClient) {
  const pending = await rows<{ command: string }>(
    ch,
    "SELECT command FROM system.mutations WHERE database=currentDatabase() AND is_done=0 AND table IN ('events','event_ids','events_by_minute','entities','attribute_keys')",
    {},
    CLICKHOUSE_PLAIN_READ,
  );
  return pending.some(({ command }) => isForeignMutationCommand(command));
}
/** A stored mutation command (system.mutations.command) that calls a function Logbird's own predicates never use. */
export function isForeignMutationCommand(command: string) {
  // String literals first (a type name such as '…DateTime64(3)' is text, not a call). ClickHouse formats a call with
  // the parenthesis right after the name (`now()`), and a keyword with a space (`WHERE (`), so only the former counts.
  const code = command.replace(/'(?:[^'\\]|\\.)*'/g, "''");
  // A subquery is never ours either.
  if (/\bSELECT\b/i.test(code)) return true;
  return [...code.matchAll(/([A-Za-z_]\w*)\(/g)].some((m) => !LOGBIRD_MUTATION_FUNCTIONS.has(m[1] as string));
}

/** Unfinished mutations on `events`, every project's: each one adds to every on-the-fly read of the table. */
export async function pendingEventMutations(ch: ClickHouseClient) {
  const counted = await rows<{ n: number }>(
    ch,
    "SELECT count() n FROM system.mutations WHERE database=currentDatabase() AND table='events' AND is_done=0",
    {},
  );
  return Number(counted[0]?.n ?? 0);
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
 * How far each derived table's totals are from what the raw rows imply (rollup minus raw; positive = the rollup counts
 * more), for the scope a retention run rewrites: minute buckets before the cutoff, entities per kind, attribute keys.
 * Normal ingest adds to both sides alike, so the drift only moves when a derived table and the raw rows disagree about
 * a change: a retention run whose derived DELETE was skipped or killed leaves it larger (round-1 finding 7). Plain
 * reads, so a pending mutation neither hides rows nor fails the read; compare two readings, never a reading with zero.
 */
export type RollupDrift = { minute: number; actor: number; tenant: number; executor: number; target: number; attributes: number };
export async function retentionRollupDrift(ch: ClickHouseClient, p: string, cutoff: Date): Promise<RollupDrift> {
  const kind = (k: string) => `(SELECT toInt64(sum(events)) FROM entities WHERE project_id={p:String} AND kind='${k}')`;
  const [row] = await rows<Record<keyof RollupDrift, number | string>>(
    projectMaintenance(ch, p),
    `WITH raw AS (SELECT toInt64(countIf(timestamp < {cutoff:DateTime64(3,'UTC')})) minute, toInt64(countIf(actor_id!='')) actor,
        toInt64(countIf(tenant_id!='')) tenant, toInt64(countIf(executor_id!='')) executor, toInt64(sum(length(target_types))) target,
        toInt64(sum(length(attributes.keys))) attributes FROM events WHERE project_id={p:String})
      SELECT
        (SELECT toInt64(sum(events)) FROM events_by_minute WHERE project_id={p:String} AND bucket < {cutoff:DateTime64(3,'UTC')}) - (SELECT minute FROM raw) minute,
        ${kind('actor')} - (SELECT actor FROM raw) actor,
        ${kind('tenant')} - (SELECT tenant FROM raw) tenant,
        ${kind('executor')} - (SELECT executor FROM raw) executor,
        ${kind('target')} - (SELECT target FROM raw) target,
        (SELECT toInt64(sum(count)) FROM attribute_keys WHERE project_id={p:String}) - (SELECT attributes FROM raw) attributes`,
    { p, cutoff: ms(cutoff) },
    CLICKHOUSE_PLAIN_READ,
  );
  const n = (key: keyof RollupDrift) => Number(row?.[key] ?? 0);
  return { minute: n('minute'), actor: n('actor'), tenant: n('tenant'), executor: n('executor'), target: n('target'), attributes: n('attributes') };
}

/** The minute-bucket part of `retentionRollupDrift` alone: exact and cheap (the timestamp key range before the cutoff). */
export async function retentionMinuteDrift(ch: ClickHouseClient, p: string, cutoff: Date): Promise<number> {
  const [row] = await rows<{ d: number | string }>(
    projectMaintenance(ch, p),
    `SELECT (SELECT toInt64(sum(events)) FROM events_by_minute WHERE project_id={p:String} AND bucket < {cutoff:DateTime64(3,'UTC')})
      - (SELECT toInt64(count()) FROM events WHERE project_id={p:String} AND timestamp < {cutoff:DateTime64(3,'UTC')}) d`,
    { p, cutoff: ms(cutoff) },
    CLICKHOUSE_PLAIN_READ,
  );
  return Number(row?.d ?? 0);
}

/**
 * The in-flight allowance for a drift reading taken between `from` and `to` (database clock): what the rows received
 * from `from - slackMs` to `to` contribute to each measure. A reading during live ingest can catch an insert after
 * its raw part and before its materialized-view part; only rows accepted in that window can be caught like that.
 * Call once they have all landed (after the settle proof). Uses the `received_at` index; a plain read.
 */
export async function retentionDriftAllowance(
  ch: ClickHouseClient,
  p: string,
  cutoff: Date,
  from: Date,
  to: Date,
  slackMs: number,
): Promise<RollupDrift> {
  const [row] = await rows<Record<keyof RollupDrift, number | string>>(
    projectMaintenance(ch, p),
    `SELECT toInt64(countIf(timestamp < {cutoff:DateTime64(3,'UTC')})) minute, toInt64(countIf(actor_id!='')) actor,
        toInt64(countIf(tenant_id!='')) tenant, toInt64(countIf(executor_id!='')) executor, toInt64(sum(length(target_types))) target,
        toInt64(sum(length(attributes.keys))) attributes
      FROM events WHERE project_id={p:String} AND received_at >= {from:DateTime64(3,'UTC')} AND received_at <= {to:DateTime64(3,'UTC')}`,
    { p, cutoff: ms(cutoff), from: ms(new Date(from.getTime() - slackMs)), to: ms(to) },
    CLICKHOUSE_PLAIN_READ,
  );
  const n = (key: keyof RollupDrift) => Number(row?.[key] ?? 0);
  return { minute: n('minute'), actor: n('actor'), tenant: n('tenant'), executor: n('executor'), target: n('target'), attributes: n('attributes') };
}

/**
 * The committed ingest watermark after fence A: the latest `received_at` stored among rows received after it, or null
 * when there are none. Fence B's delta (rows received between the fences) must reach every row already written, even
 * one whose stamp is later than the database clock read at fence B (an export watermark from another clock, or the
 * millisecond that `ingestReceiptClock` adds after a lease). Call only after the settle proof, under the exclusive
 * lock, so no write is in flight. A plain read: a pending mutation can neither hide a row nor fail the read.
 */
export async function committedReceivedAfter(ch: ClickHouseClient, p: string, fenceA: Date): Promise<Date | null> {
  const [row] = await rows<{ n: number | string; last: number | string }>(
    projectMaintenance(ch, p),
    `SELECT count() n, toUnixTimestamp64Milli(max(received_at)) last FROM events WHERE project_id={p:String} AND received_at > {fenceA:DateTime64(3,'UTC')}`,
    { p, fenceA: ms(fenceA) },
    CLICKHOUSE_PLAIN_READ,
  );
  return Number(row?.n ?? 0) > 0 ? new Date(Number(row?.last)) : null;
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
