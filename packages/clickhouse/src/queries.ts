import { randomUUID } from 'node:crypto';
import type {
  AuditEvent,
  Entity,
  EntityKind,
  EntityProfile,
  EntitySort,
  EventDetail,
  ExportQuery,
  entityListQuerySchema,
  FacetResponse,
  facetQuerySchema,
  fieldsResponseSchema,
  HistogramResponse,
  histogramQuerySchema,
  OverviewResponse,
  RangeQuery,
  SearchQuery,
  SearchResponse,
} from '@logbird/contracts';
import { EXPORT_SCHEMA_VERSION, pickHistogramInterval, QUERY_FIELDS } from '@logbird/contracts';
import type { z } from 'zod';
import type { ClickHouseClient } from './client';
import { isQueryClient } from './client';
import { CSV_COLUMNS, csvEvent } from './export';
import { projectMaintenance } from './maintenance-tag';
import type { EventRow } from './normalize';
import { columns, compileQuery, QueryError } from './query';
import { rollupSql } from './rollup-sql';
import { freezeSqlClock, sqlSyntaxError, validateSql } from './sql-guard';

const sqlExpression = Symbol('sqlExpression');
async function filter(ch: ClickHouseClient, q: { q?: string; lang?: string }, now?: number) {
  if (q.lang !== 'sql') return compileQuery(q.q, now);
  if (!isQueryClient(ch)) throw new Error('SQL mode requires the restricted query client');
  const sql = await validateSql(ch, q.q);
  const frozen = now === undefined ? { sql, params: {} } : freezeSqlClock(sql, now);
  return { sql: frozen.sql, params: { ...frozen.params, [sqlExpression]: q.q ?? '' } };
}

type Params = Record<string, unknown>;
export type ExportExecution = { signal: AbortSignal; cancelQuery: (queryId: string) => Promise<void> };
export async function read<T>(
  ch: ClickHouseClient,
  query: string,
  parameters: Params = {},
  guard = 10,
  exportBudget = false,
  execution?: ExportExecution,
): Promise<T[]> {
  const query_params = { ...parameters };
  for (const key of ['from', 'to', 'cursorTs', 'hour', 'since', 'cutoff', 'exportReceivedBefore']) {
    const value = query_params[key];
    if (typeof value === 'string') query_params[key] = new Date(value).toISOString().replace('T', ' ').slice(0, -1);
  }
  // These parameters come from the authorized project arguments, never the SQL
  // expression. Bind per HTTP query, not on the shared client's session.
  const project = query_params.project ?? query_params.p;
  if (isQueryClient(ch) && (typeof project !== 'string' || !project)) throw new Error('Restricted query requires one project');
  execution?.signal.throwIfAborted();
  const queryId = execution ? randomUUID() : undefined;
  let cancellation: Promise<void> | undefined;
  const cancel = () => {
    if (!execution || !queryId) return;
    cancellation ??= execution.cancelQuery(queryId).catch(() => {
      console.error(JSON.stringify({ event: 'export.query_cancel_failed', queryId }));
    });
  };
  execution?.signal.addEventListener('abort', cancel, { once: true });
  try {
    const rows = await (
      await ch.query({
        query,
        query_id: queryId,
        query_params,
        format: 'JSONEachRow',
        clickhouse_settings: {
          max_execution_time: isQueryClient(ch) ? 10 : guard,
          // Restricted SQL's CONST profile supplies 1-GiB memory/read limits and reserves both API admission slots.
          ...(exportBudget && !isQueryClient(ch)
            ? { max_memory_usage: '134217728', max_bytes_to_read: '268435456', read_overflow_mode: 'throw' as const, max_threads: 2 }
            : {}),
          ...(isQueryClient(ch) ? { SQL_logbird_project: project as string } : {}),
        },
      })
    ).json<T>();
    execution?.signal.throwIfAborted();
    return rows;
  } catch (error) {
    if (
      /TOO_MANY_ROWS|TOO_MANY_BYTES|TIMEOUT_EXCEEDED|MEMORY_LIMIT_EXCEEDED|TOO_SLOW|LIMIT_EXCEEDED/.test(
        (error instanceof Error ? error.message : '') + (error && typeof error === 'object' && 'type' in error ? String(error.type) : ''),
      )
    )
      throw new QueryError('Query exceeded its resource budget', {
        lang: isQueryClient(ch) ? 'sql' : 'query',
        reason: 'limit',
        start: null,
        end: null,
        hint: 'Narrow the time range or filter',
      });
    if (isQueryClient(ch) && /SYNTAX_ERROR|Syntax error/.test(error instanceof Error ? error.message : ''))
      throw sqlSyntaxError(error, query, (query_params as Record<symbol, string>)[sqlExpression] ?? '');
    throw error;
  } finally {
    execution?.signal.removeEventListener('abort', cancel);
    // Keep the original response open: aborting HTTP alone does not prove the SELECT stopped.
    // An early KILL with no match still waits for this read to finish before releasing capacity.
    await cancellation;
  }
}
export function timeRange(q: RangeQuery, now = Date.now()) {
  const to = new Date(q.to ?? now),
    from = new Date(q.from ?? to.getTime() - 86_400_000);
  if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || from >= to) throw new Error('Invalid time range');
  return { from: from.toISOString(), to: to.toISOString() };
}
export async function where(ch: ClickHouseClient, projectId: string, q: RangeQuery, compiled?: Awaited<ReturnType<typeof filter>>) {
  const c = compiled ?? (await filter(ch, q));
  return {
    sql: `project_id={project:String} AND timestamp >= {from:DateTime64(3)} AND timestamp < {to:DateTime64(3)} AND (${c.sql})`,
    params: { project: projectId, ...timeRange(q), ...c.params },
  };
}
const iso = (s: string) => new Date(s.endsWith('Z') ? s : `${s.replace(' ', 'T')}Z`).toISOString();
export function toEvent(r: EventRow & { category?: string }): AuditEvent {
  return {
    id: r.event_id,
    projectId: r.project_id,
    timestamp: iso(r.timestamp),
    receivedAt: iso(r.received_at),
    environment: r.environment,
    action: r.action,
    category: r.category ?? r.action.split('.')[0] ?? '',
    outcome: r.outcome,
    severity: r.severity,
    description: r.description,
    actor: r.actor_id || r.actor_type ? { id: r.actor_id, type: r.actor_type, name: r.actor_name, email: r.actor_email } : null,
    impersonator: r.impersonator_id ? { id: r.impersonator_id, name: r.impersonator_name } : null,
    executor:
      r.executor_id || r.executor_type
        ? { id: r.executor_id, type: r.executor_type, name: r.executor_name, jobId: r.job_id, attempt: r.job_attempt }
        : null,
    tenant: r.tenant_id ? { id: r.tenant_id, name: r.tenant_name } : null,
    source: r.source || null,
    targets: r.target_ids.map((id, i) => ({ id, type: r.target_types[i] ?? '', name: r.target_names[i] ?? '' })),
    changes: r.changes_fields.map((field, i) => ({ field, before: r.changes_before[i] ?? '', after: r.changes_after[i] ?? '' })),
    context: {
      operationId: r.operation_id,
      parentEventId: r.parent_event_id,
      requestId: r.request_id,
      traceId: r.trace_id,
      ip: r.ip,
      userAgent: r.user_agent,
    },
    attributes: r.attributes,
    conformance: r.conformance,
    schemaVersion: r.schema_version,
    sdk: r.sdk,
  };
}
const encode = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
function cursor(s: string): [string, string] {
  try {
    const a: unknown = JSON.parse(Buffer.from(s, 'base64url').toString());
    if (Array.isArray(a) && a.length === 2 && a.every((v) => typeof v === 'string')) return a as [string, string];
  } catch {
    /* Report malformed cursors with a stable public error below. */
  }
  throw new Error('Invalid cursor');
}
async function searchPage(
  ch: ClickHouseClient,
  projectId: string,
  q: SearchQuery,
  compiled?: Awaited<ReturnType<typeof filter>>,
  includePayload = false,
  exportClock?: string,
  execution?: ExportExecution,
): Promise<{ page: SearchResponse; payloads: string[] }> {
  const start = performance.now(),
    w = await where(ch, projectId, q, compiled),
    asc = q.order === 'asc',
    op = asc ? '>' : '<',
    order = asc ? 'ASC' : 'DESC';
  let tail = '';
  const params: Params = { ...w.params, limit: q.limit + 1 };
  if (exportClock) {
    w.sql += ' AND received_at <= {exportReceivedBefore:DateTime64(3)}';
    params.exportReceivedBefore = exportClock;
  }
  if (q.cursor) {
    const [ts, id] = cursor(q.cursor);
    params.cursorTs = ts;
    params.cursorId = id;
    tail = ` AND (timestamp,event_id) ${op} ({cursorTs:DateTime64(3)},{cursorId:String})`;
  }
  const rows = await read<EventRow>(
    ch,
    // Select pairs in the MergeTree's timestamp/id order; resolve receipt ties only in the bounded fetch.
    // Legacy versions can share the entire pointer tuple; recheck their filters before outer dedupe.
    `SELECT * EXCEPT(${includePayload ? 'search_text' : 'payload,search_text'}) FROM events WHERE ${w.sql} AND (timestamp,event_id) IN (SELECT timestamp,event_id FROM events WHERE ${w.sql}${tail} ORDER BY timestamp ${order},event_id ${order} LIMIT 1 BY event_id LIMIT {limit:UInt32}) ORDER BY timestamp ${order},event_id ${order},received_at ASC LIMIT 1 BY event_id LIMIT {limit:UInt32}`,
    params,
    10,
    Boolean(exportClock),
    execution,
  );
  const hasMore = rows.length > q.limit,
    data = rows.slice(0, q.limit).map(toEvent),
    last = data.at(-1);
  const total = exportClock
    ? 0
    : Number(
        (await read<{ n: number }>(ch, `SELECT count() n FROM (SELECT DISTINCT event_id FROM events WHERE ${w.sql} LIMIT 10001)`, w.params, 1))[0]
          ?.n ?? 0,
      );
  return {
    page: { data, total, nextCursor: hasMore && last ? encode([last.timestamp, last.id]) : null, tookMs: performance.now() - start },
    payloads: includePayload ? rows.slice(0, q.limit).map((row) => row.payload) : [],
  };
}
export async function searchEvents(
  ch: ClickHouseClient,
  projectId: string,
  q: SearchQuery,
  compiled?: Awaited<ReturnType<typeof filter>>,
): Promise<SearchResponse> {
  return (await searchPage(ch, projectId, q, compiled)).page;
}
async function eventRow(ch: ClickHouseClient, p: string, id: string) {
  return (
    await read<EventRow>(ch, 'SELECT * FROM events WHERE project_id={p:String} AND event_id={id:String} ORDER BY received_at,timestamp LIMIT 1', {
      p,
      id,
    })
  )[0];
}
export async function getEvent(ch: ClickHouseClient, projectId: string, eventId: string): Promise<EventDetail | null> {
  const row = await eventRow(ch, projectId, eventId);
  if (!row) return null;
  const parents: AuditEvent[] = [],
    seen = new Set([eventId]);
  let parent = row.parent_event_id;
  while (parent && !seen.has(parent) && parents.length < 100) {
    seen.add(parent);
    const r = await eventRow(ch, projectId, parent);
    if (!r) break;
    parents.unshift(toEvent(r));
    parent = r.parent_event_id;
  }
  const counts = (
    await read<{ children: number; size: number }>(
      ch,
      `SELECT uniqExactIf(event_id,parent_event_id={id:String}) children,uniqExactIf(event_id,operation_id={op:String} AND operation_id!='') size FROM events WHERE project_id={p:String} AND (parent_event_id={id:String} OR operation_id={op:String})`,
      { p: projectId, id: eventId, op: row.operation_id },
    )
  )[0];
  return {
    event: toEvent(row),
    payload: JSON.parse(row.payload),
    parents,
    childCount: Number(counts?.children ?? 0),
    operationSize: Number(counts?.size ?? 0),
  };
}
export async function liveEvents(ch: ClickHouseClient, p: string, q: { since: string; q?: string; lang?: string; limit: number }) {
  const compiled = await filter(ch, q);
  return (
    await read<EventRow>(
      ch,
      `SELECT * EXCEPT(payload,search_text) FROM events WHERE project_id={p:String} AND received_at >= {since:DateTime64(3)} AND (${compiled.sql}) ORDER BY received_at DESC,event_id DESC LIMIT 1 BY event_id LIMIT {limit:UInt32}`,
      { p, since: q.since, limit: q.limit, ...compiled.params },
    )
  ).map(toEvent);
}
export async function histogram(ch: ClickHouseClient, p: string, q: z.infer<typeof histogramQuerySchema>): Promise<HistogramResponse> {
  const w = await where(ch, p, q),
    range = timeRange(q),
    interval = q.interval ?? pickHistogramInterval(Date.parse(range.to) - Date.parse(range.from));
  const step = interval * 1000;
  const start = Math.floor(Date.parse(range.from) / step) * step;
  if (Math.ceil((Date.parse(range.to) - start) / step) > 10_000) throw new Error('Query exceeds 10000 histogram buckets');
  const rows = await read<{ ts: string; outcome: string; n: number }>(
    ch,
    `SELECT toStartOfInterval(timestamp,toIntervalSecond({interval:UInt32})) ts,outcome,count() n FROM events WHERE ${w.sql} GROUP BY ts,outcome ORDER BY ts`,
    { ...w.params, interval },
  );
  const buckets = new Map<string, { ts: string; total: number; byOutcome: Record<string, number> }>();
  const outcomes = [...new Set(rows.map((r) => r.outcome))];
  for (let t = start; t < Date.parse(range.to); t += step) {
    const ts = new Date(t).toISOString();
    buckets.set(ts, { ts, total: 0, byOutcome: Object.fromEntries(outcomes.map((outcome) => [outcome, 0])) });
  }
  for (const r of rows) {
    const ts = iso(r.ts),
      b = buckets.get(ts) ?? { ts, total: 0, byOutcome: {} };
    b.total += Number(r.n);
    b.byOutcome[r.outcome] = Number(r.n);
    buckets.set(ts, b);
  }
  return { interval, buckets: [...buckets.values()] };
}
export async function facets(ch: ClickHouseClient, p: string, q: z.infer<typeof facetQuerySchema>): Promise<FacetResponse> {
  const w = await where(ch, p, q),
    col = Object.hasOwn(columns, q.field) ? columns[q.field] : undefined;
  let expr = col;
  if (!expr) {
    expr = 'attributes[{attr:String}]';
  }
  let join = '';
  let label = expr;
  if (expr === 'target_ids') {
    join = 'ARRAY JOIN arrayZip(target_ids,target_names) AS target';
    expr = 'target.1';
    label = 'target.2';
  } else if (['target_types', 'target_names', 'changes_fields'].includes(expr)) {
    expr = `arrayJoin(${expr})`;
    label = expr;
  } else if (['actor', 'impersonator', 'tenant', 'executor'].includes(q.field)) label = `${q.field}_name`;
  if (QUERY_FIELDS.some((f) => f.column === col && ['number', 'date'].includes(f.type))) {
    expr = `toString(${expr})`;
    label = expr;
  }
  // Only the top `limit` groups leave ClickHouse; the window sum (computed before LIMIT) keeps otherCount exact.
  const rows = await read<{ value: string; label: string; count: number; total: number }>(
    ch,
    `SELECT ${expr} value,coalesce(nullIf(argMaxIf(${label},received_at,${label}!=''),''),value) label,count() count,sum(count()) OVER () total FROM events ${join} WHERE ${w.sql} GROUP BY value ORDER BY count DESC,value LIMIT {facetLimit:UInt32}`,
    { ...w.params, attr: q.field.replace(/^(attr|attributes)\./, ''), facetLimit: q.limit },
  );
  const values = rows.map((r) => ({ value: r.value, label: r.label, count: Number(r.count) }));
  const total = Number(rows[0]?.total ?? 0);
  return { field: q.field, values, otherCount: Math.max(total - values.reduce((n, v) => n + v.count, 0), 0) };
}
async function metrics(ch: ClickHouseClient, p: string, q: RangeQuery) {
  const w = await where(ch, p, q);
  return (
    (
      await read<{ events: number; actors: number; tenants: number; failureRate: number; avgConformance: number }>(
        ch,
        `SELECT count() events,uniqExactIf(actor_id,actor_id!='') actors,uniqExactIf(tenant_id,tenant_id!='') tenants,if(count()=0,0,countIf(outcome IN ('failure','denied'))/count()) failureRate,if(count()=0,0,avg(conformance)) avgConformance FROM events WHERE ${w.sql}`,
        w.params,
      )
    )[0] ?? { events: 0, actors: 0, tenants: 0, failureRate: 0, avgConformance: 0 }
  );
}
async function top(ch: ClickHouseClient, p: string, q: RangeQuery, col: string, label: string, type = "''") {
  const w = await where(ch, p, q);
  return read<{ id: string; label: string; type: string; count: number }>(
    ch,
    `SELECT ${col} id,coalesce(nullIf(argMaxIf(${label},received_at,${label}!=''),''),id) label,argMax(${type},timestamp) type,count() count FROM events WHERE ${w.sql} AND ${col}!='' GROUP BY id ORDER BY count DESC,id LIMIT 10`,
    w.params,
  );
}
export async function overview(ch: ClickHouseClient, p: string, q: RangeQuery): Promise<OverviewResponse> {
  const range = timeRange(q),
    duration = Date.parse(range.to) - Date.parse(range.from),
    now = new Date(),
    hour = new Date(now.getTime() - 3_600_000).toISOString();
  const [m, prev, series, topActions, topActors, topTenants, topExecutors, recentProblems, stats, minutes] = await Promise.all([
    metrics(ch, p, q),
    metrics(ch, p, { ...q, from: new Date(Date.parse(range.from) - duration).toISOString(), to: range.from }),
    histogram(ch, p, q),
    top(ch, p, q, 'action', 'action'),
    top(ch, p, q, 'actor_id', 'actor_name', 'actor_type'),
    top(ch, p, q, 'tenant_id', 'tenant_name'),
    top(ch, p, q, 'executor_id', 'executor_name', 'executor_type'),
    read<EventRow>(
      ch,
      `SELECT * FROM events WHERE ${(await where(ch, p, q)).sql} AND (outcome IN ('failure','denied') OR severity='critical') ORDER BY timestamp DESC LIMIT 10`,
      (await where(ch, p, q)).params,
    ),
    projectStats(ch, [p]),
    read<{ ts: string; count: number }>(
      ch,
      'SELECT bucket ts,sum(events) count FROM events_by_minute WHERE project_id={p:String} AND bucket >= {hour:DateTime64(3)} GROUP BY bucket ORDER BY bucket',
      { p, hour },
    ),
  ]);
  return {
    kpis: {
      events: Number(m.events),
      eventsPrev: Number(prev.events),
      actors: Number(m.actors),
      actorsPrev: Number(prev.actors),
      tenants: Number(m.tenants),
      failureRate: m.failureRate,
      failureRatePrev: prev.failureRate,
      avgConformance: m.avgConformance,
    },
    series,
    topActions,
    topActors,
    topTenants,
    topExecutors,
    recentProblems: recentProblems.map(toEvent),
    ingest: {
      lastEventAt: stats[p]?.lastEventAt ?? null,
      eventsLastHour: minutes.reduce((n, r) => n + Number(r.count), 0),
      perMinute: minutes.map((r) => ({ ts: iso(r.ts), count: Number(r.count) })),
    },
  };
}
type EntityListQuery = Omit<z.infer<typeof entityListQuerySchema>, 'sort'> & { sort?: EntitySort };
/**
 * Keyset ordering per sort. Every key sorts ascending (desc keys are negated) and ends with `id`, so the tuple
 * comparison `(k1,k2,id) > cursor` pages without gaps or duplicates for a stable snapshot.
 */
const ENTITY_ORDER: Record<EntitySort, { keys: string; types: [string, string] }> = {
  events: { keys: '-toInt64(events),-toUnixTimestamp64Milli(lastSeen)', types: ['Int64', 'Int64'] },
  lastSeen: { keys: '-toUnixTimestamp64Milli(lastSeen),-toInt64(events)', types: ['Int64', 'Int64'] },
  name: { keys: "lowerUTF8(if(name='',id,name)),''", types: ['String', 'String'] },
};
export async function listEntities(ch: ClickHouseClient, p: string, q: EntityListQuery) {
  const sort = q.sort ?? 'events',
    order = ENTITY_ORDER[sort];
  let after = '';
  const params: Params = { p, kind: q.kind, q: q.q ?? '', type: q.type ?? '', limit: q.limit + 1 };
  if (q.cursor) {
    const [c1, c2, id] = entityCursor(q.cursor, sort);
    Object.assign(params, { c1, c2, cid: id });
    after = `WHERE (${order.keys},id) > ({c1:${order.types[0]}},{c2:${order.types[1]}},{cid:String})`;
  }
  const rows = await read<Entity & { k1: string | number; k2: string | number }>(
    ch,
    `SELECT *,tupleElement(k,1) k1,tupleElement(k,2) k2 FROM (SELECT *,tuple(${order.keys}) k FROM (SELECT kind,entity_id id,anyLast(type) type,anyLast(name) name,min(first_seen) firstSeen,max(last_seen) lastSeen,sum(events) events FROM entities WHERE project_id={p:String} AND kind={kind:String} GROUP BY kind,id HAVING ({q:String}='' OR positionCaseInsensitiveUTF8(concat(id,' ',name),{q:String})>0 OR ngramSearchCaseInsensitiveUTF8(concat(id,' ',name),{q:String})>0.3) AND ({type:String}='' OR type={type:String}))) ${after} ORDER BY k,id LIMIT {limit:UInt32}`,
    params,
    // Directory pages aggregate the whole kind; keep the guard roomy but bounded.
    isQueryClient(ch) ? 10 : 20,
  );
  const last = rows[q.limit - 1];
  return {
    data: rows.slice(0, q.limit).map((r) => ({
      kind: r.kind,
      id: r.id,
      type: r.type,
      name: r.name,
      firstSeen: iso(r.firstSeen),
      lastSeen: iso(r.lastSeen),
      events: Number(r.events),
    })),
    nextCursor: rows.length > q.limit && last ? encode([sort, String(last.k1), String(last.k2), last.id]) : null,
  };
}
function entityCursor(s: string, sort: EntitySort): [string, string, string] {
  try {
    const a: unknown = JSON.parse(Buffer.from(s, 'base64url').toString());
    if (Array.isArray(a) && a.length === 4 && a.every((v) => typeof v === 'string') && a[0] === sort) {
      const [, k1, k2, id] = a as [string, string, string, string];
      return [k1, k2, id];
    }
  } catch {
    /* Report malformed or cross-sort cursors with a stable public error below. */
  }
  throw new Error('Invalid cursor');
}
function sqlLiteral(s: string) {
  return `'${s.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
}
function entityFilter(kind: EntityKind, id: string) {
  return kind === 'target'
    ? `target.type:${JSON.stringify(id.slice(0, id.indexOf(':')))} target:${JSON.stringify(id.slice(id.indexOf(':') + 1))}`
    : `${kind}:${JSON.stringify(id)}`;
}
export async function entityProfile(ch: ClickHouseClient, p: string, kind: EntityKind, id: string, q: RangeQuery): Promise<EntityProfile | null> {
  const raw = (
    await read<Entity>(
      ch,
      'SELECT kind,entity_id id,anyLast(type) type,anyLast(name) name,min(first_seen) firstSeen,max(last_seen) lastSeen,sum(events) events FROM entities WHERE project_id={p:String} AND kind={kind:String} AND entity_id={id:String} GROUP BY kind,id',
      { p, kind, id },
    )
  )[0];
  const entity = raw ? { ...raw, firstSeen: iso(raw.firstSeen), lastSeen: iso(raw.lastSeen), events: Number(raw.events) } : undefined;
  if (!entity) return null;
  const entitySql =
    kind === 'target'
      ? `has(target_ids,${sqlLiteral(id.slice(id.indexOf(':') + 1))}) AND has(target_types,${sqlLiteral(id.slice(0, id.indexOf(':')))})`
      : `${kind}_id = ${sqlLiteral(id)}`;
  const scoped = { ...q, q: q.lang === 'sql' ? `(${q.q || '1'}) AND (${entitySql})` : `${q.q ? `(${q.q})` : ''} ${entityFilter(kind, id)}` };
  const [series, topActions, outcomes] = await Promise.all([
    histogram(ch, p, scoped),
    top(ch, p, scoped, 'action', 'action'),
    facets(ch, p, { ...scoped, field: 'outcome', limit: 100 }),
  ]);
  const related: EntityProfile['related'] = [];
  for (const k of ['actor', 'tenant', 'executor', 'target'] as const) {
    if (k === kind) continue;
    const w = await where(ch, p, scoped),
      target = k === 'target',
      idCol = target ? "concat(t.1,':',t.2)" : `${k}_id`,
      nameCol = target ? 't.3' : `${k}_name`,
      typeCol = target ? 't.1' : k === 'tenant' ? "''" : `${k}_type`;
    const rs = await read<{ id: string; name: string; type: string; count: number }>(
      ch,
      `SELECT ${idCol} id,any(${nameCol}) name,any(${typeCol}) type,count() count FROM events ${target ? 'ARRAY JOIN arrayZip(target_types,target_ids,target_names) AS t' : ''} WHERE ${w.sql} AND ${idCol}!='' GROUP BY id ORDER BY count DESC LIMIT 10`,
      w.params,
    );
    related.push(...rs.map((r) => ({ ...r, kind: k, count: Number(r.count) })));
  }
  return { entity, series, topActions, outcomes: Object.fromEntries(outcomes.values.map((v) => [v.value, v.count])), related };
}
export async function listFields(ch: ClickHouseClient, p: string, q: RangeQuery): Promise<z.infer<typeof fieldsResponseSchema>> {
  const w = await where(ch, p, q),
    m = await metrics(ch, p, q);
  const attrs = await read<{ key: string; n: number; distinct: number; samples: string[]; last: string }>(
    ch,
    `SELECT k key,count() n,uniq(attributes[k]) distinct,groupUniqArray(5)(attributes[k]) samples,max(timestamp) last FROM events ARRAY JOIN mapKeys(attributes) AS k WHERE ${w.sql} GROUP BY k`,
    w.params,
  );
  const data: z.infer<typeof fieldsResponseSchema>['data'] = attrs.map((r) => ({
    key: `attr.${r.key}`,
    kind: 'attribute',
    coverage: Number(r.n) / Math.max(1, m.events),
    distinctApprox: Number(r.distinct),
    samples: r.samples,
    lastSeen: iso(r.last),
  }));
  for (const [key, col] of Object.entries(columns)) {
    if (QUERY_FIELDS.find((f) => f.column === col)?.type === 'array' || key === 'env') continue;
    const value = `toString(${col})`;
    const r = (
      await read<{ n: number; distinct: number; samples: string[]; last: string | null }>(
        ch,
        `SELECT countIf(${value}!='') n,uniqIf(${col},${value}!='') distinct,groupUniqArrayIf(5)(${value},${value}!='') samples,maxOrNullIf(timestamp,${value}!='') last FROM events WHERE ${w.sql}`,
        w.params,
      )
    )[0];
    if (r)
      data.push({
        key,
        kind: 'core',
        coverage: Number(r.n) / Math.max(1, m.events),
        distinctApprox: Number(r.distinct),
        samples: r.samples,
        lastSeen: r.last ? iso(r.last) : null,
      });
  }
  return { data, avgConformance: m.avgConformance };
}
export async function operationEvents(ch: ClickHouseClient, p: string, operationId: string) {
  return (
    await read<EventRow>(
      ch,
      'SELECT * FROM events WHERE project_id={p:String} AND operation_id={operationId:String} ORDER BY timestamp,event_id LIMIT 1 BY timestamp,event_id',
      { p, operationId },
    )
  ).map(toEvent);
}
/** Capture one query clock and compiled predicate; callers persist these resolved boundaries in export receipts. */
export async function prepareExport(ch: ClickHouseClient, q: ExportQuery, clock = Date.now()) {
  const range = timeRange(q, clock);
  const compiled = await filter(ch, q, clock);
  return { range, compiled, clock: new Date(clock).toISOString() };
}
export type ExportPlan = Awaited<ReturnType<typeof prepareExport>>;
export async function* exportEvents(ch: ClickHouseClient, p: string, q: ExportQuery, plan?: ExportPlan, execution?: ExportExecution) {
  const frozen = plan ?? (await prepareExport(ch, q));
  const query = { ...q, ...frozen.range };
  let nextCursor: string | undefined;
  let first = true;
  do {
    const { page, payloads } = await searchPage(
      ch,
      p,
      { ...query, cursor: nextCursor, limit: 200, order: 'asc' },
      frozen.compiled,
      q.format === 'jsonl-evidence',
      frozen.clock,
      execution,
    );
    if (first && q.format === 'csv') yield `${CSV_COLUMNS.join(',')}\n`;
    first = false;
    for (const [index, e] of page.data.entries()) {
      if (q.format === 'jsonl-evidence') {
        // Same selected physical row, including when legacy conflicting versions share every identity timestamp.
        const payload = payloads[index];
        if (payload === undefined) throw new Error('Export payload no longer available');
        if (/[\r\n]/u.test(payload)) throw new Error('Export payload contains a line separator');
        try {
          JSON.parse(payload);
        } catch {
          throw new Error('Export payload is not valid stored JSON');
        }
        // Validate syntax only; emit stored text unchanged, including numbers beyond JS's exact integer range.
        yield `{"exportSchemaVersion":${EXPORT_SCHEMA_VERSION},"event":${JSON.stringify(e)},"payload":${payload}}\n`;
      } else yield q.format === 'jsonl' ? `${JSON.stringify({ ...e, exportSchemaVersion: EXPORT_SCHEMA_VERSION })}\n` : csvEvent(e);
    }
    nextCursor = page.nextCursor ?? undefined;
  } while (nextCursor);
}
export async function projectStats(
  ch: ClickHouseClient,
  projectIds: string[],
): Promise<Record<string, { lastEventAt: string | null; eventsLast24h: number }>> {
  if (!projectIds.length) return {};
  if (isQueryClient(ch) && projectIds.length > 1) {
    const results = await Promise.all(projectIds.map((p) => projectStats(ch, [p])));
    return Object.assign({}, ...results);
  }
  const rows = await read<{ project_id: string; last: string; n: number }>(
    ch,
    'SELECT project_id,max(timestamp) last,countIf(timestamp>=now()-INTERVAL 24 HOUR) n FROM events WHERE project_id IN {projects:Array(String)} GROUP BY project_id',
    { projects: projectIds, p: projectIds[0] },
  );
  const result = Object.fromEntries(projectIds.map((p) => [p, { lastEventAt: null as string | null, eventsLast24h: 0 }]));
  for (const r of rows) result[r.project_id] = { lastEventAt: iso(r.last), eventsLast24h: Number(r.n) };
  return result;
}
export async function hasExpiredEvents(ch: ClickHouseClient, p: string, before: Date) {
  const rows = await read<{ n: number }>(
    ch,
    'SELECT (SELECT count() FROM (SELECT 1 FROM events WHERE project_id={p:String} AND timestamp < {before:DateTime64(3)} LIMIT 1)) + (SELECT count() FROM (SELECT 1 FROM event_ids WHERE project_id={p:String} AND timestamp < {before:DateTime64(3)} LIMIT 1)) n',
    { p, before: before.toISOString().replace('T', ' ').slice(0, -1) },
  );
  return Number(rows[0]?.n ?? 0) > 0;
}

export const DELETE_ATTEMPTS = 3;
/**
 * Project-scoped maintenance DELETE that proves its effect. `table` and `filter` are trusted code, never input. The
 * predicate is built here as `project_id={p:String} AND (filter)` with `p` bound to `projectId`, so no filter (even
 * one containing OR) can reach another project. Every statement is tagged as `projectId`'s maintenance so project
 * deletion can stop it.
 *
 * Any caller whose project can have live writers must hold the project's exclusive lock, so no new matching rows can
 * arrive between attempts: a retry only re-applies a mutation that ClickHouse skipped (ClickHouse#124167). Only a
 * whole-project purge with no writers (e.g. a test or script fixture) needs none.
 */
export async function deleteAndVerify(
  client: ClickHouseClient,
  projectId: string,
  table: string,
  filter = '',
  params: Params = {},
  // A caller that treats the failure as non-fatal (stale identity pointers) logs its own warning instead.
  { logIncomplete = true }: { logIncomplete?: boolean } = {},
) {
  if ('p' in params) throw new Error('deleteAndVerify binds p to projectId itself; do not pass params.p');
  const predicate = `project_id={p:String}${filter ? ` AND (${filter})` : ''}`;
  const bound = { ...params, p: projectId };
  const ch = projectMaintenance(client, projectId);
  for (let attempt = 1; attempt <= DELETE_ATTEMPTS; attempt++) {
    await ch.command({
      query: `DELETE FROM ${table} WHERE ${predicate}`,
      query_params: bound,
      clickhouse_settings: { mutations_sync: '2', lightweight_deletes_sync: '2' },
    });
    // Concurrent non-replicated mutations can register out of order and skip rows.
    // Retry with a fresh mutation version, but still fail closed for restored parts
    // that outrank every attempt. Completion alone never proves deletion.
    // The probe binds exactly the DELETE's params (not through read(), which rewrites date keys and turns a timeout
    // into a 422 query-budget error). A filter outside the sort key (sample-data `source`) scans the whole project once
    // nothing matches, so it gets a maintenance budget; a storage error or timeout propagates as a retryable 503.
    const rows = await (
      await ch.query({
        query: `SELECT count() n FROM (SELECT 1 FROM ${table} WHERE ${predicate} LIMIT 1)`,
        query_params: bound,
        format: 'JSONEachRow',
        clickhouse_settings: { max_execution_time: 60 },
      })
    ).json<{ n: number }>();
    if (Number(rows[0]?.n ?? 0) === 0) return;
    if (attempt < DELETE_ATTEMPTS) {
      console.warn(JSON.stringify({ level: 'warn', event: 'clickhouse.delete_retry', table, projectId, attempt: attempt + 1 }));
      await new Promise((resolve) => setTimeout(resolve, 50 * attempt));
    }
  }
  // One log line for every fail-closed caller (server, worker, scripts); the restore gate greps for it.
  if (logIncomplete)
    console.error(JSON.stringify({ level: 'error', event: 'clickhouse.delete_incomplete', table, projectId, attempts: DELETE_ATTEMPTS }));
  throw Object.assign(
    new Error(
      `Delete left visible rows in ${table} after ${DELETE_ATTEMPTS} attempts. Retry the operation; if it persists on a natively restored database, stop writers and follow the ClickHouse restore normalization procedure.`,
    ),
    { code: 'LOGBIRD_DELETE_INCOMPLETE', table, attempts: DELETE_ATTEMPTS },
  );
}

export async function purgeProject(client: ClickHouseClient, p: string, before?: Date) {
  // Every statement is tagged as this project's maintenance, whoever the caller is (see maintenance-tag.ts).
  const ch = projectMaintenance(client, p);
  // Caller serializes ingestion. Capture only aggregate keys touched by expired rows.
  // deleteAndVerify binds p itself; only the affected-key read and the rollup INSERT take it here.
  const cutoffParams = {
    before: before?.toISOString().replace('T', ' ').slice(0, -1),
    bucket: before ? new Date(Math.floor(before.getTime() / 60_000) * 60_000).toISOString().replace('T', ' ').slice(0, -1) : undefined,
  };
  const params = { p, ...cutoffParams };
  const affected = before
    ? await read<{ kind: string; id: string }>(
        ch,
        `SELECT DISTINCT kind,id FROM (
    SELECT 'actor' kind,actor_id id FROM events WHERE project_id={p:String} AND timestamp < {before:DateTime64(3)} AND actor_id!=''
    UNION ALL SELECT 'tenant',tenant_id FROM events WHERE project_id={p:String} AND timestamp < {before:DateTime64(3)} AND tenant_id!=''
    UNION ALL SELECT 'executor',executor_id FROM events WHERE project_id={p:String} AND timestamp < {before:DateTime64(3)} AND executor_id!=''
    UNION ALL SELECT 'target',concat(t.1,':',t.2) FROM events ARRAY JOIN arrayZip(target_types,target_ids) AS t WHERE project_id={p:String} AND timestamp < {before:DateTime64(3)}
    UNION ALL SELECT 'attribute',arrayJoin(mapKeys(attributes)) FROM events WHERE project_id={p:String} AND timestamp < {before:DateTime64(3)})`,
        params,
      )
    : [];
  const cutoff = before ? 'timestamp < {before:DateTime64(3)}' : '';
  await deleteAndVerify(ch, p, 'events', cutoff, cutoffParams);
  await deleteAndVerify(ch, p, 'event_ids', cutoff, cutoffParams);
  // The required 007/008 migration repairs collapsed legacy pointers once before rollout.
  // Its plain MergeTree/MV keeps every raw tuple, so cutoff deletion preserves surviving
  // versions without scanning retained history under the exclusive project lock.

  if (!before) return rebuildProjectRollups(ch, p, false);
  const filters = {
    events_by_minute: 'bucket <= {bucket:DateTime64(3)}',
    entities: '(kind,entity_id) IN arrayZip({kinds:Array(String)},{entityIds:Array(String)})',
    attribute_keys: 'key IN {keys:Array(String)}',
  };
  const scopedParams = {
    ...cutoffParams,
    kinds: affected.filter((r) => r.kind !== 'attribute').map((r) => r.kind),
    entityIds: affected.filter((r) => r.kind !== 'attribute').map((r) => r.id),
    keys: affected.filter((r) => r.kind === 'attribute').map((r) => r.id),
  };
  for (const [table, filter] of Object.entries(filters)) await deleteAndVerify(ch, p, table, filter, scopedParams);
  // Recompute the boundary minute and affected entity/key histories exactly; newer buckets stay intact.
  for (const statement of rollupSql.split(';')) {
    const m = statement.match(/CREATE MATERIALIZED VIEW IF NOT EXISTS \w+ TO (\w+) AS (SELECT[\s\S]+)/);
    if (!m) continue;
    const table = m[1] as keyof typeof filters;
    await ch.command({
      query: `INSERT INTO ${table} SELECT * FROM (${m[2]}) WHERE project_id={p:String} AND ${filters[table]}`,
      query_params: { ...scopedParams, p },
    });
  }
}

/** Caller holds the project ingestion lock. Rebuild from surviving raw rows. */
export async function rebuildProjectRollups(client: ClickHouseClient, p: string, rebuild = true) {
  const ch = projectMaintenance(client, p);
  for (const table of ['events_by_minute', 'entities', 'attribute_keys']) await deleteAndVerify(ch, p, table);
  if (rebuild) {
    for (const statement of rollupSql.split(';')) {
      const m = statement.match(/CREATE MATERIALIZED VIEW IF NOT EXISTS \w+ TO (\w+) AS (SELECT[\s\S]+)/);
      if (!m) continue;
      const select = m[2]?.replace(
        /FROM events(.*?)(WHERE |GROUP BY )/s,
        (_all, join: string, clause: string) =>
          `FROM events${join}${clause === 'WHERE ' ? 'WHERE project_id={p:String} AND ' : 'WHERE project_id={p:String} GROUP BY '}`,
      );
      await ch.command({ query: `INSERT INTO ${m[1]} ${select}`, query_params: { p } });
    }
  }
}

/** Read-only retention preview, scoped to the authorized project. */
export async function retentionStats(ch: ClickHouseClient, p: string, days?: number) {
  const rows = await read<{ oldest: string | null; n: string }>(
    ch,
    'SELECT minOrNull(timestamp) oldest,countIf(timestamp < {cutoff:DateTime64(3)}) n FROM events WHERE project_id={p:String}',
    { p, cutoff: new Date(Date.now() - (days ?? 3650) * 86_400_000).toISOString() },
  );
  return { oldestEventAt: rows[0]?.oldest ? iso(rows[0].oldest) : null, previewDeletedEvents: days === undefined ? null : Number(rows[0]?.n ?? 0) };
}
