import type {
  AuditEvent,
  Entity,
  EntityKind,
  EntityProfile,
  EventDetail,
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
} from '@trailmark/contracts';
import type { z } from 'zod';
import type { ClickHouseClient } from './client';
import type { EventRow } from './normalize';
import { columns, compileQuery } from './query';

type Params = Record<string, unknown>;
async function read<T>(ch: ClickHouseClient, query: string, query_params: Params = {}, guard = 10): Promise<T[]> {
  for (const key of ['from', 'to', 'cursorTs', 'hour']) {
    const value = query_params[key];
    if (typeof value === 'string') query_params[key] = new Date(value).toISOString().replace('T', ' ').slice(0, -1);
  }
  return (await ch.query({ query, query_params, format: 'JSONEachRow', clickhouse_settings: { max_execution_time: guard } })).json<T>();
}
export function timeRange(q: RangeQuery) {
  const to = new Date(q.to ?? Date.now()),
    from = new Date(q.from ?? to.getTime() - 86_400_000);
  if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || from >= to) throw new Error('Invalid time range');
  return { from: from.toISOString(), to: to.toISOString() };
}
function where(projectId: string, q: RangeQuery) {
  const c = compileQuery(q.q);
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
export async function searchEvents(ch: ClickHouseClient, projectId: string, q: SearchQuery): Promise<SearchResponse> {
  const start = performance.now(),
    w = where(projectId, q),
    asc = q.order === 'asc',
    op = asc ? '>' : '<',
    order = asc ? 'ASC' : 'DESC';
  let tail = '';
  const params: Params = { ...w.params, limit: q.limit + 1 };
  if (q.cursor) {
    const [ts, id] = cursor(q.cursor);
    params.cursorTs = ts;
    params.cursorId = id;
    tail = ` AND (timestamp,event_id) ${op} ({cursorTs:DateTime64(3)},{cursorId:String})`;
  }
  const rows = await read<EventRow>(
    ch,
    `SELECT * EXCEPT(payload,search_text) FROM events WHERE project_id={project:String} AND (timestamp,event_id) IN (SELECT timestamp,event_id FROM events WHERE ${w.sql}${tail} ORDER BY timestamp ${order},event_id ${order} LIMIT 1 BY timestamp,event_id LIMIT {limit:UInt32}) ORDER BY timestamp ${order},event_id ${order} LIMIT 1 BY timestamp,event_id`,
    params,
  );
  const hasMore = rows.length > q.limit,
    data = rows.slice(0, q.limit).map(toEvent),
    last = data.at(-1);
  const total = Number(
    (await read<{ n: number }>(ch, `SELECT count() n FROM (SELECT DISTINCT event_id FROM events WHERE ${w.sql} LIMIT 10001)`, w.params, 1))[0]?.n ??
      0,
  );
  return { data, total, nextCursor: hasMore && last ? encode([last.timestamp, last.id]) : null, tookMs: performance.now() - start };
}
async function eventRow(ch: ClickHouseClient, p: string, id: string) {
  return (
    await read<EventRow>(ch, 'SELECT * FROM events WHERE project_id={p:String} AND event_id={id:String} ORDER BY received_at DESC LIMIT 1', { p, id })
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
export async function liveEvents(ch: ClickHouseClient, p: string, q: { since: string; q?: string; limit: number }) {
  return (await searchEvents(ch, p, { from: q.since, q: q.q, limit: q.limit, order: 'desc' })).data;
}
export async function histogram(ch: ClickHouseClient, p: string, q: z.infer<typeof histogramQuerySchema>): Promise<HistogramResponse> {
  const w = where(p, q),
    range = timeRange(q),
    interval = q.interval ?? Math.max(1, Math.ceil((Date.parse(range.to) - Date.parse(range.from)) / 60_000));
  const rows = await read<{ ts: string; outcome: string; n: number }>(
    ch,
    `SELECT toStartOfInterval(timestamp,toIntervalSecond({interval:UInt32})) ts,outcome,count() n FROM events WHERE ${w.sql} GROUP BY ts,outcome ORDER BY ts`,
    { ...w.params, interval },
  );
  const buckets = new Map<string, { ts: string; total: number; byOutcome: Record<string, number> }>();
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
  const w = where(p, q),
    col = Object.hasOwn(columns, q.field) ? columns[q.field] : undefined;
  let expr = col;
  if (!expr) {
    if (!q.field.startsWith('attr.')) throw new Error('Invalid facet field');
    expr = 'attributes[{attr:String}]';
  }
  if (expr === 'target_types') expr = 'arrayJoin(target_types)';
  const rows = await read<{ value: string; count: number }>(
    ch,
    `SELECT ${expr} value,count() count FROM events WHERE ${w.sql} GROUP BY value ORDER BY count DESC,value`,
    { ...w.params, attr: q.field.slice(5) },
  );
  return {
    field: q.field,
    values: rows.slice(0, q.limit).map((r) => ({ ...r, label: r.value, count: Number(r.count) })),
    otherCount: rows.slice(q.limit).reduce((n, r) => n + Number(r.count), 0),
  };
}
async function metrics(ch: ClickHouseClient, p: string, q: RangeQuery) {
  const w = where(p, q);
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
  const w = where(p, q);
  return read<{ id: string; label: string; type: string; count: number }>(
    ch,
    `SELECT ${col} id,argMax(${label},timestamp) label,argMax(${type},timestamp) type,count() count FROM events WHERE ${w.sql} AND ${col}!='' GROUP BY id ORDER BY count DESC,id LIMIT 10`,
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
      `SELECT * FROM events WHERE ${where(p, q).sql} AND (outcome IN ('failure','denied') OR severity='critical') ORDER BY timestamp DESC LIMIT 10`,
      where(p, q).params,
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
export async function listEntities(ch: ClickHouseClient, p: string, q: z.infer<typeof entityListQuerySchema>) {
  const rows = await read<Entity>(
    ch,
    `SELECT kind,entity_id id,anyLast(type) type,anyLast(name) name,min(first_seen) firstSeen,max(last_seen) lastSeen,sum(events) events FROM entities WHERE project_id={p:String} AND kind={kind:String} GROUP BY kind,id HAVING ({q:String}='' OR positionCaseInsensitiveUTF8(concat(id,' ',name),{q:String})>0 OR ngramSearchCaseInsensitiveUTF8(concat(id,' ',name),{q:String})>0.3) AND ({type:String}='' OR type={type:String}) AND id>{cursor:String} ORDER BY id LIMIT {limit:UInt32}`,
    { p, kind: q.kind, q: q.q ?? '', type: q.type ?? '', cursor: q.cursor ?? '', limit: q.limit + 1 },
  );
  return {
    data: rows.slice(0, q.limit).map((r) => ({ ...r, firstSeen: iso(r.firstSeen), lastSeen: iso(r.lastSeen), events: Number(r.events) })),
    nextCursor: rows.length > q.limit ? (rows[q.limit - 1]?.id ?? null) : null,
  };
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
  const scoped = { ...q, q: `${q.q ?? ''} ${entityFilter(kind, id)}` };
  const [series, topActions, outcomes] = await Promise.all([
    histogram(ch, p, scoped),
    top(ch, p, scoped, 'action', 'action'),
    facets(ch, p, { ...scoped, field: 'outcome', limit: 100 }),
  ]);
  const related: EntityProfile['related'] = [];
  for (const k of ['actor', 'tenant', 'executor', 'target'] as const) {
    if (k === kind) continue;
    const w = where(p, scoped),
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
  const w = where(p, q),
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
    if (col.startsWith('target_') || key === 'env') continue;
    const r = (
      await read<{ n: number; distinct: number; samples: string[]; last: string | null }>(
        ch,
        `SELECT countIf(${col}!='') n,uniqIf(${col},${col}!='') distinct,groupUniqArrayIf(5)(${col},${col}!='') samples,maxOrNullIf(timestamp,${col}!='') last FROM events WHERE ${w.sql}`,
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
export async function* exportEvents(ch: ClickHouseClient, p: string, q: RangeQuery & { format: 'csv' | 'jsonl' }) {
  let nextCursor: string | undefined;
  let first = true;
  do {
    const page = await searchEvents(ch, p, { ...q, cursor: nextCursor, limit: 200, order: 'asc' });
    if (first && q.format === 'csv') yield 'id,timestamp,action,outcome,description\n';
    first = false;
    for (const e of page.data)
      yield q.format === 'jsonl'
        ? `${JSON.stringify(e)}\n`
        : `${[e.id, e.timestamp, e.action, e.outcome, e.description].map((v) => `"${v.replaceAll('"', '""')}"`).join(',')}\n`;
    nextCursor = page.nextCursor ?? undefined;
  } while (nextCursor);
}
export async function projectStats(
  ch: ClickHouseClient,
  projectIds: string[],
): Promise<Record<string, { lastEventAt: string | null; eventsLast24h: number }>> {
  if (!projectIds.length) return {};
  const rows = await read<{ project_id: string; last: string; n: number }>(
    ch,
    'SELECT project_id,max(timestamp) last,countIf(timestamp>=now()-INTERVAL 24 HOUR) n FROM events WHERE project_id IN {projects:Array(String)} GROUP BY project_id',
    { projects: projectIds },
  );
  const result = Object.fromEntries(projectIds.map((p) => [p, { lastEventAt: null as string | null, eventsLast24h: 0 }]));
  for (const r of rows) result[r.project_id] = { lastEventAt: iso(r.last), eventsLast24h: Number(r.n) };
  return result;
}
export async function purgeProject(ch: ClickHouseClient, p: string, before?: Date) {
  // Caller must serialize purge with ingestion for this project while aggregates rebuild.
  await ch.command({
    query: `DELETE FROM events WHERE project_id={p:String}${before ? ' AND timestamp < {before:DateTime64(3)}' : ''}`,
    query_params: { p, before: before?.toISOString().replace('T', ' ').slice(0, -1) },
    clickhouse_settings: { mutations_sync: '2', lightweight_deletes_sync: '2' },
  });
  for (const table of ['events_by_minute', 'entities', 'attribute_keys'])
    await ch.command({
      query: `DELETE FROM ${table} WHERE project_id={p:String}`,
      query_params: { p },
      clickhouse_settings: { mutations_sync: '2', lightweight_deletes_sync: '2' },
    });
  if (before) {
    const { readFile } = await import('node:fs/promises');
    const sql = await readFile(new URL('../migrations/002_rollups.sql', import.meta.url), 'utf8');
    for (const statement of sql.split(';')) {
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
