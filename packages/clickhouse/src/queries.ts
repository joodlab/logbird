import { randomUUID } from 'node:crypto';
import type {
  AuditEvent,
  Entity,
  EntityKind,
  EntityMetadata,
  EntityProfile,
  EntityProfileQuery,
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
  ReadScope,
  SearchQuery,
  SearchResponse,
} from '@logbird/contracts';
import { EXPORT_SCHEMA_VERSION, pickHistogramInterval, QUERY_FIELDS, RECENT_PROBLEM_OUTCOMES, RECENT_PROBLEM_SEVERITY } from '@logbird/contracts';
import type { z } from 'zod';
import type { ClickHouseClient } from './client';
import { boundTenant, isQueryClient } from './client';
import { CSV_COLUMNS, csvEvent } from './export';
import { projectMaintenance } from './maintenance-tag';
import type { EventRow } from './normalize';
import { columns, compileQuery, QueryError, recordTargetPredicate } from './query';
import { rollupSql } from './rollup-sql';
import { CursorError, cursorBinding, scopePredicate } from './scope';
import { freezeSqlClock, sqlSyntaxError, validateSql } from './sql-guard';

const sqlExpression = Symbol('sqlExpression');
async function filter(ch: ClickHouseClient, q: { q?: string; lang?: string }, now?: number) {
  if (q.lang !== 'sql') return compileQuery(q.q, now);
  if (!isQueryClient(ch)) throw new Error('SQL mode requires the restricted query client');
  const sql = await validateSql(ch, q.q);
  const frozen = now === undefined ? { sql, params: {} } : freezeSqlClock(sql, now);
  return { sql: frozen.sql, params: { ...frozen.params, [sqlExpression]: q.q ?? '' } };
}

type CompiledFilter = Awaited<ReturnType<typeof filter>>;
type Params = Record<string, unknown>;
export type ExportExecution = {
  signal: AbortSignal;
  cancelQuery: (queryId: string) => Promise<void>;
  /** Recorded as ClickHouse `log_comment` on every page query (e.g. the export id), for audits and tests. */
  tag?: string;
};
export async function read<T>(
  ch: ClickHouseClient,
  query: string,
  parameters: Params = {},
  guard = 10,
  exportBudget = false,
  execution?: ExportExecution,
  /** Aborting closes the HTTP request; ClickHouse then cancels the read-only statement. */
  abortSignal?: AbortSignal,
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
  // A tenant-bound client always sends its tenant; a scope predicate in the query must name the same tenant.
  const bound = boundTenant(ch);
  if (bound !== undefined && typeof query_params.scope_tenant === 'string' && query_params.scope_tenant !== bound)
    throw new Error('Scope tenant does not match the bound tenant');
  const tenant = bound ?? (typeof query_params.scope_tenant === 'string' ? query_params.scope_tenant : '');
  // Error reports name the language the caller used: SQL-mode filters carry the expression symbol, and the unbound
  // restricted client serves only the console's SQL mode (its auxiliary reads too); tenant-bound clients serve /v1.
  const lang = sqlExpression in query_params || (isQueryClient(ch) && bound === undefined) ? 'sql' : 'query';
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
  let closeOnAbort: (() => void) | undefined;
  try {
    const resultSet = await ch.query({
      query,
      query_id: queryId,
      query_params,
      format: 'JSONEachRow',
      abort_signal: abortSignal,
      clickhouse_settings: {
        ...(abortSignal ? { cancel_http_readonly_queries_on_client_close: 1 } : {}),
        ...(execution?.tag ? { log_comment: execution.tag } : {}),
        max_execution_time: isQueryClient(ch) ? 10 : guard,
        // Restricted SQL's CONST profile supplies 1-GiB memory/read limits and reserves both API admission slots.
        ...(exportBudget && !isQueryClient(ch)
          ? { max_memory_usage: '134217728', max_bytes_to_read: '268435456', read_overflow_mode: 'throw' as const, max_threads: 2 }
          : {}),
        // Scoped reads bind their tenant so the row policy enforces it too (#138 phase 2).
        ...(isQueryClient(ch) ? { SQL_logbird_project: project as string, SQL_logbird_tenant: tenant } : {}),
      },
    });
    // The driver stops watching abort_signal once headers arrive; close the body stream ourselves so a stalled body
    // cannot outlive an abort.
    if (abortSignal) {
      closeOnAbort = () => resultSet.close();
      if (abortSignal.aborted) closeOnAbort();
      else abortSignal.addEventListener('abort', closeOnAbort, { once: true });
    }
    const rows = await resultSet.json<T>();
    execution?.signal.throwIfAborted();
    return rows;
  } catch (error) {
    if (
      /TOO_MANY_ROWS|TOO_MANY_BYTES|TIMEOUT_EXCEEDED|MEMORY_LIMIT_EXCEEDED|TOO_SLOW|LIMIT_EXCEEDED/.test(
        (error instanceof Error ? error.message : '') + (error && typeof error === 'object' && 'type' in error ? String(error.type) : ''),
      )
    )
      throw new QueryError('Query exceeded its resource budget', {
        lang,
        reason: 'limit',
        start: null,
        end: null,
        hint: 'Narrow the time range or filter',
      });
    if (lang === 'sql' && /SYNTAX_ERROR|Syntax error/.test(error instanceof Error ? error.message : ''))
      throw sqlSyntaxError(error, query, (query_params as Record<symbol, string>)[sqlExpression] ?? '');
    throw error;
  } finally {
    if (closeOnAbort) abortSignal?.removeEventListener('abort', closeOnAbort);
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
export async function where(ch: ClickHouseClient, projectId: string, q: RangeQuery, compiled?: CompiledFilter, scope?: ReadScope | null) {
  const c = compiled ?? (await filter(ch, q));
  const s = scopePredicate(scope);
  // The scope is ANDed outside the user's filter: nothing inside `(c.sql)` can widen it.
  return {
    sql: `project_id={project:String} AND timestamp >= {from:DateTime64(3)} AND timestamp < {to:DateTime64(3)} AND (${c.sql}) AND (${s.sql})`,
    params: { project: projectId, ...timeRange(q), ...c.params, ...s.params },
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
/**
 * Search cursors are `[timestamp, eventId, binding]`: the binding ties them to the project, and to the scope when
 * minted by a scoped caller. Two-element cursors (issued before bindings existed) stay valid for unscoped readers only.
 */
function cursor(s: string, projectId: string, scope?: ReadScope | null): [string, string] {
  const bound = cursorBinding(projectId, scope);
  try {
    const a: unknown = JSON.parse(Buffer.from(s, 'base64url').toString());
    // A cursor only pages within the project and scope that minted it: another project, unscoped ↔ scoped and
    // scope A ↔ scope B are rejected, and so is a malformed position (it would otherwise fail later as a 500 or be
    // silently normalized, e.g. February 30).
    const binds = Array.isArray(a) && (a.length === 3 ? a[2] === bound : a.length === 2 && !scope);
    if (binds && a.every((v) => typeof v === 'string')) {
      const [ts, id] = a as [string, string];
      const date = new Date(ts);
      if (
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(ts) &&
        Number.isFinite(date.getTime()) &&
        date.toISOString() === ts &&
        id &&
        id.length <= 1024
      )
        return [ts, id];
    }
  } catch {
    /* Report malformed cursors with a stable public error below. */
  }
  throw new CursorError();
}
/** Distinct matches up to the 10,001 cap. `exact` is false when capped, past its budget, cancelled or failed. */
export const COUNT_CAP = 10_001;
/** Wall-clock budget for the count, also for restricted SQL whose CONST profile allows statements 10 seconds. */
export const COUNT_BUDGET_MS = 1000;
type CountResult = { n: number; exact: boolean };
/**
 * The count settles by its deadline whatever its HTTP request is doing (stalled headers or body): the deadline resolves
 * the lower-bound fallback and aborts the request. Server cleanup differs by client: the writable client's statement
 * stops at its one-second max_execution_time; the restricted readonly client's statement is cancelled when ClickHouse
 * notices the closed connection (cooperative), bounded by its CONST ten-second profile.
 */
function countMatches(ch: ClickHouseClient, w: { sql: string; params: Params }) {
  const controller = new AbortController();
  const fallback: CountResult = { n: 0, exact: false };
  let stopped: 'budget' | 'settled' | undefined;
  let settle: (value: CountResult) => void = () => undefined;
  const deadline = new Promise<CountResult>((resolve) => {
    settle = resolve;
  });
  const stop = (why: 'budget') => {
    if (stopped) return;
    stopped = why;
    console.warn(JSON.stringify({ level: 'warn', event: 'search.count_unavailable', reason: why }));
    controller.abort();
    settle(fallback);
  };
  const timer = setTimeout(() => stop('budget'), COUNT_BUDGET_MS);
  const counted = (async (): Promise<CountResult> => {
    try {
      const sql = `SELECT count() n FROM (SELECT DISTINCT event_id FROM events WHERE ${w.sql} LIMIT ${COUNT_CAP})`;
      const n = Number((await read<{ n: number }>(ch, sql, w.params, 1, false, undefined, controller.signal))[0]?.n ?? 0);
      stopped ??= 'settled'; // a later cancel() is a no-op
      return { n, exact: n < COUNT_CAP };
    } catch (error) {
      if (!stopped) {
        stopped = 'settled';
        const reason = error instanceof QueryError ? error.details.reason : 'error';
        console.warn(JSON.stringify({ level: 'warn', event: 'search.count_unavailable', reason }));
      }
      return fallback;
    } finally {
      clearTimeout(timer);
    }
  })();
  return { result: Promise.race([counted, deadline]) };
}
async function searchPage(
  ch: ClickHouseClient,
  projectId: string,
  q: SearchQuery,
  compiled?: Awaited<ReturnType<typeof filter>>,
  includePayload = false,
  exportClock?: string,
  execution?: ExportExecution,
  scope?: ReadScope | null,
): Promise<{ page: SearchResponse; payloads: string[] }> {
  const start = performance.now(),
    w = await where(ch, projectId, q, compiled, scope),
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
    const [ts, id] = cursor(q.cursor, projectId, scope);
    params.cursorTs = ts;
    params.cursorId = id;
    tail = ` AND (timestamp,event_id) ${op} ({cursorTs:DateTime64(3)},{cursorId:String})`;
  }
  const readRows = () =>
    read<EventRow>(
      ch,
      // Select pairs in the MergeTree's timestamp/id order; resolve receipt ties only in the bounded fetch.
      // Legacy versions can share the entire pointer tuple; recheck their filters before outer dedupe.
      `SELECT * EXCEPT(${includePayload ? 'search_text' : 'payload,search_text'}) FROM events WHERE ${w.sql} AND (timestamp,event_id) IN (SELECT timestamp,event_id FROM events WHERE ${w.sql}${tail} ORDER BY timestamp ${order},event_id ${order} LIMIT 1 BY event_id LIMIT {limit:UInt32}) ORDER BY timestamp ${order},event_id ${order},received_at ASC LIMIT 1 BY event_id LIMIT {limit:UInt32}`,
      params,
      10,
      Boolean(exportClock),
      execution,
    );
  // Rows first and alone, as before: the optional count never competes with them for a ClickHouse query slot, and a
  // row error surfaces unchanged. The count then gets at most COUNT_BUDGET_MS and can only lower the total's precision.
  const rows = await readRows();
  const hasMore = rows.length > q.limit,
    data = rows.slice(0, q.limit).map(toEvent),
    last = data.at(-1);
  const count = exportClock ? undefined : await countMatches(ch, w).result;
  // Lower bound when the count did not finish: the rows seen, plus the extra row that proves there are more.
  const seen = data.length + (hasMore ? 1 : 0);
  // A count from an earlier snapshot can be below what this page proves; never report less than that.
  const total = count === undefined ? 0 : Math.max(count.n, seen);
  const totalExact = count === undefined ? true : count.exact && count.n >= seen;
  return {
    page: {
      data,
      total,
      totalExact,
      nextCursor: hasMore && last ? encode([last.timestamp, last.id, cursorBinding(projectId, scope)]) : null,
      tookMs: performance.now() - start,
    },
    payloads: includePayload ? rows.slice(0, q.limit).map((row) => row.payload) : [],
  };
}
export async function searchEvents(
  ch: ClickHouseClient,
  projectId: string,
  q: SearchQuery,
  compiled?: Awaited<ReturnType<typeof filter>>,
  scope?: ReadScope | null,
): Promise<SearchResponse> {
  return (await searchPage(ch, projectId, q, compiled, false, undefined, undefined, scope)).page;
}
async function eventRow(ch: ClickHouseClient, p: string, id: string, scope?: ReadScope | null, canonicalClient?: ClickHouseClient) {
  // Oldest receipt first, then timestamp, then a hash of the stored document: a deterministic canonical version even
  // for legacy rows that tie on both timestamps.
  const canonical =
    'SELECT * FROM events WHERE project_id={p:String} AND event_id={id:String} ORDER BY received_at,timestamp,sipHash64(payload) LIMIT 1';
  if (!scope) return (await read<EventRow>(ch, canonical, { p, id }))[0];
  const s = scopePredicate(scope);
  if (canonicalClient && canonicalClient !== ch) {
    // A row-policy-bound client only sees its tenant's rows, so it would pick the oldest version *of its tenant* as
    // canonical. Choose the canonical version project-wide and test the scope on it in the same lookup (a pointer and
    // a flag, nothing else). An unknown id and an out-of-scope id both end here, with one query and the same answer;
    // only an in-scope version is then fetched, exactly, through the bound client.
    const [pointer] = await read<{ received_at: string; timestamp: string; h: string; in_scope: number }>(
      canonicalClient,
      `SELECT received_at, timestamp, toString(sipHash64(payload)) h, (${s.sql}) in_scope FROM events WHERE project_id={p:String} AND event_id={id:String} ORDER BY received_at,timestamp,sipHash64(payload) LIMIT 1`,
      { p, id, ...s.params },
    );
    if (!pointer || !Number(pointer.in_scope)) return;
    return (
      await read<EventRow>(
        ch,
        `SELECT * FROM events WHERE project_id={p:String} AND event_id={id:String} AND received_at={pointerReceived:DateTime64(3, 'UTC')} AND timestamp={pointerTimestamp:DateTime64(3, 'UTC')} AND sipHash64(payload)={pointerHash:UInt64} AND ${s.sql} LIMIT 1`,
        { p, id, pointerReceived: pointer.received_at, pointerTimestamp: pointer.timestamp, pointerHash: pointer.h, ...s.params },
      )
    )[0];
  }
  // Pick the canonical stored row first, then test the scope on it: a scoped caller sees exactly the row an unscoped
  // reader sees, or nothing (never a different stored version that happens to match).
  return (await read<EventRow>(ch, `SELECT * FROM (${canonical}) WHERE ${s.sql}`, { p, id, ...s.params }))[0];
}
/** With a scope, an out-of-scope id is indistinguishable from an unknown one (null → 404). */
export async function getEvent(
  ch: ClickHouseClient,
  projectId: string,
  eventId: string,
  scope?: ReadScope | null,
  /** With a row-policy-bound `ch`: the unrestricted client that picks the canonical version of each id. */
  canonicalClient?: ClickHouseClient,
): Promise<EventDetail | null> {
  const row = await eventRow(ch, projectId, eventId, scope, canonicalClient);
  if (!row) return null;
  const parents: AuditEvent[] = [],
    seen = new Set([eventId]);
  let parent = row.parent_event_id;
  while (parent && !seen.has(parent) && parents.length < 100) {
    seen.add(parent);
    // The chain stops at the first parent outside the scope.
    const r = await eventRow(ch, projectId, parent, scope, canonicalClient);
    if (!r) break;
    parents.unshift(toEvent(r));
    parent = r.parent_event_id;
  }
  const s = scopePredicate(scope);
  const counts = (
    await read<{ children: number; size: number }>(
      ch,
      `SELECT uniqExactIf(event_id,parent_event_id={id:String}) children,uniqExactIf(event_id,operation_id={op:String} AND operation_id!='') size FROM events WHERE project_id={p:String} AND (parent_event_id={id:String} OR operation_id={op:String}) AND (${s.sql})`,
      { p: projectId, id: eventId, op: row.operation_id, ...s.params },
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
export async function histogram(
  ch: ClickHouseClient,
  p: string,
  q: z.infer<typeof histogramQuerySchema>,
  compiled?: CompiledFilter,
): Promise<HistogramResponse> {
  const w = await where(ch, p, q, compiled),
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
const TARGET_COLUMNS = ['target_ids', 'target_types', 'target_names'];
/** Two target-level facets expand ONE (id, type, name) tuple, so an id is never paired with another target's type. */
const SHARED_TARGETS = 'ARRAY JOIN arrayZip(target_ids,target_types,target_names) AS facet_targets';
/** SQL for one facet level: the grouped value, its display label and an optional ARRAY JOIN. */
function facetLevel(field: string, n: number, sharedTargets = false) {
  const col = Object.hasOwn(columns, field) ? columns[field] : undefined;
  let expr = col ?? `attributes[{attr${n}:String}]`;
  let join = '';
  let label = expr;
  if (sharedTargets && col && TARGET_COLUMNS.includes(col)) {
    // The caller adds SHARED_TARGETS once for both levels.
    expr = `facet_targets.${TARGET_COLUMNS.indexOf(col) + 1}`;
    label = col === 'target_ids' ? 'facet_targets.3' : expr;
  } else if (expr === 'target_ids') {
    join = `ARRAY JOIN arrayZip(target_ids,target_names) AS facet_target${n}`;
    expr = `facet_target${n}.1`;
    label = `facet_target${n}.2`;
  } else if (['target_types', 'target_names', 'changes_fields'].includes(expr)) {
    expr = `arrayJoin(${expr})`;
    label = expr;
  } else if (['actor', 'impersonator', 'tenant', 'executor'].includes(field)) label = `${field}_name`;
  else if (!col) {
    // Array-valued attributes are stored as JSON text ("[\"a\",\"b\"]"): count each element (#140). Strings unwrap;
    // other element types keep their JSON text. An empty array contributes no group.
    const a = `attributes[{attr${n}:String}]`;
    // JSON whitespace (space, tab, LF, CR) may precede the array; the scalar fallback keeps the original text.
    const lead = `trimLeft(replaceAll(replaceAll(replaceAll(${a},char(9),' '),char(10),' '),char(13),' '))`;
    expr = `arrayJoin(if(startsWith(${lead},'[') AND isValidJSON(${a}),arrayMap(x -> if(JSONType(x)='String',JSONExtractString(x),x),JSONExtractArrayRaw(${a})),[${a}]))`;
    label = expr;
  }
  if (QUERY_FIELDS.some((f) => f.column === col && ['number', 'date'].includes(f.type))) {
    expr = `toString(${expr})`;
    label = expr;
  }
  return { expr, label, join, column: col, params: col ? {} : { [`attr${n}`]: field.replace(/^(attr|attributes)\./, '') } };
}
/** The stored column a facet field reads (undefined for attributes). */
export const facetColumn = (field: string) => (Object.hasOwn(columns, field) ? columns[field] : undefined);
export async function facets(
  ch: ClickHouseClient,
  p: string,
  q: Omit<z.infer<typeof facetQuerySchema>, 'byLimit'> & { byLimit?: number },
  scope?: ReadScope | null,
  compiled?: CompiledFilter,
): Promise<FacetResponse> {
  const w = await where(ch, p, q, compiled, scope);
  const one = facetLevel(q.field, 1);
  // Only the top `limit` groups leave ClickHouse; the window sum (computed before LIMIT) keeps otherCount exact.
  const rows = await read<{ value: string; label: string; count: number; total: number }>(
    ch,
    `SELECT ${one.expr} value,coalesce(nullIf(argMaxIf(${one.label},received_at,${one.label}!=''),''),value) label,count() count,sum(count()) OVER () total FROM events ${one.join} WHERE ${w.sql} GROUP BY value ORDER BY count DESC,value LIMIT {facetLimit:UInt32}`,
    { ...w.params, ...one.params, facetLimit: q.limit },
  );
  const values: FacetResponse['values'] = rows.map((r) => ({ value: r.value, label: r.label, count: Number(r.count) }));
  const total = Number(rows[0]?.total ?? 0);
  const otherCount = Math.max(total - values.reduce((n, v) => n + v.count, 0), 0);
  if (!q.by || !values.length) return { field: q.field, by: q.by ?? null, values, otherCount };
  // Second level (#140): the top `byLimit` values of `by` within each returned value, and the count of the rest.
  // One bounded query: the outer filter keeps only the returned first-level values.
  const isTarget = (field: string) => TARGET_COLUMNS.includes(facetColumn(field) ?? '');
  const shared = isTarget(q.field) && isTarget(q.by);
  const both = shared ? { one: facetLevel(q.field, 1, true), two: facetLevel(q.by, 2, true) } : { one, two: facetLevel(q.by, 2) };
  const two = both.two;
  const joins = shared ? SHARED_TARGETS : `${one.join} ${two.join}`;
  const groups = await read<{ value: string; grp: string; label: string; count: number; total: number }>(
    ch,
    `SELECT value,grp,coalesce(nullIf(argMaxIf(glabel,received_at,glabel!=''),''),grp) label,count() count,sum(count()) OVER (PARTITION BY value) total FROM (SELECT ${both.one.expr} value,${two.expr} grp,${two.label} glabel,received_at FROM events ${joins} WHERE ${w.sql}) WHERE value IN {facetValues:Array(String)} GROUP BY value,grp ORDER BY value,count DESC,grp LIMIT {byLimit:UInt32} BY value`,
    { ...w.params, ...one.params, ...two.params, facetValues: values.map((v) => v.value), byLimit: q.byLimit ?? 5 },
  );
  for (const v of values) {
    const mine = groups.filter((g) => g.value === v.value);
    v.groups = mine.map((g) => ({ value: g.grp, label: g.label, count: Number(g.count) }));
    v.groupsOtherCount = Math.max(Number(mine[0]?.total ?? 0) - v.groups.reduce((n, g) => n + g.count, 0), 0);
  }
  return { field: q.field, by: q.by, values, otherCount };
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
async function top(ch: ClickHouseClient, p: string, q: RangeQuery, col: string, label: string, type = "''", compiled?: CompiledFilter) {
  const w = await where(ch, p, q, compiled);
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
      `SELECT * FROM events WHERE ${(await where(ch, p, q)).sql} AND (outcome IN (${RECENT_PROBLEM_OUTCOMES.map((o) => `'${o}'`).join(',')}) OR severity='${RECENT_PROBLEM_SEVERITY}') ORDER BY timestamp DESC LIMIT 10`,
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

const ENTITY_NAMES = 'kind,entity_id id,anyLast(type) type,anyLast(name) name';
const ENTITY_BY_ID = 'FROM entities WHERE project_id={p:String} AND kind={kind:String} AND entity_id={id:String} GROUP BY kind,id';

function ambiguousTarget(kind: EntityKind, id: string) {
  return kind === 'target' && id.indexOf(':') !== id.lastIndexOf(':');
}

/** Read the display metadata only. The composite rollup key cannot distinguish pairs containing colons. */
export async function entityMetadata(
  ch: ClickHouseClient,
  p: string,
  kind: EntityKind,
  id: string,
  targetType?: string,
): Promise<EntityMetadata | null> {
  const ambiguous = ambiguousTarget(kind, id);
  const rollup =
    ambiguous && targetType !== undefined
      ? undefined
      : (await read<EntityMetadata>(ch, `SELECT ${ENTITY_NAMES} ${ENTITY_BY_ID}`, { p, kind, id }))[0];
  if (kind !== 'target') return rollup ?? null;
  const type = targetType ?? rollup?.type;
  if (type === undefined || !id.startsWith(`${type}:`)) return null;
  if (!ambiguous) return rollup ?? null;

  const pair = recordTargetPredicate(type, id.slice(type.length + 1));
  const [event] = await read<EntityMetadata>(
    ch,
    `SELECT 'target' kind, {id:String} id, {recordType:String} type,
       arrayFirst((n, t, i) -> t = {recordType:String} AND i = {recordId:String}, target_names, target_types, target_ids) name
     FROM events WHERE project_id={p:String} AND (${pair.sql}) ORDER BY timestamp DESC,event_id DESC LIMIT 1`,
    { p, id, ...pair.params },
  );
  return event ?? null;
}

export async function entityProfile(
  ch: ClickHouseClient,
  p: string,
  kind: EntityKind,
  id: string,
  q: EntityProfileQuery,
): Promise<EntityProfile | null> {
  const ambiguous = ambiguousTarget(kind, id);
  const rollup =
    ambiguous && q.targetType !== undefined
      ? undefined
      : (
          await read<Entity>(ch, `SELECT ${ENTITY_NAMES},min(first_seen) firstSeen,max(last_seen) lastSeen,sum(events) events ${ENTITY_BY_ID}`, {
            p,
            kind,
            id,
          })
        )[0];
  if (!ambiguous && !rollup) return null;
  const targetType = kind === 'target' ? (q.targetType ?? rollup?.type) : undefined;
  if (kind === 'target' && (targetType === undefined || !id.startsWith(`${targetType}:`))) return null;

  // Compose trusted predicates after SQL-mode validation. Use separate bindings
  // from the user filter, which may itself include record terms.
  const userFilter = await filter(ch, q);
  const entityFilter =
    targetType !== undefined
      ? recordTargetPredicate(targetType, id.slice(targetType.length + 1))
      : { sql: `${kind}_id = {entityId:String}`, params: { entityId: id } };
  // The rollup loses the pair when several types and ids share a composite key.
  const raw = ambiguous
    ? (
        await read<Entity>(
          ch,
          `SELECT 'target' kind, {id:String} id, {recordType:String} type,
           argMax(arrayFirst((n, t, i) -> t = {recordType:String} AND i = {recordId:String}, target_names, target_types, target_ids), (timestamp,event_id)) name,
           min(timestamp) firstSeen, max(timestamp) lastSeen, count() events
         FROM events WHERE project_id={p:String} AND (${entityFilter.sql}) HAVING count() > 0`,
          { p, id, ...entityFilter.params },
        )
      )[0]
    : rollup;
  if (!raw) return null;
  const entity = { ...raw, firstSeen: iso(raw.firstSeen), lastSeen: iso(raw.lastSeen), events: Number(raw.events) };
  const scoped = { sql: `(${userFilter.sql}) AND (${entityFilter.sql})`, params: { ...userFilter.params, ...entityFilter.params } };
  const w = await where(ch, p, q, scoped);
  const [series, topActions, outcomes] = await Promise.all([
    histogram(ch, p, q, scoped),
    top(ch, p, q, 'action', 'action', "''", scoped),
    facets(ch, p, { ...q, field: 'outcome', limit: 100 }, undefined, scoped),
  ]);
  const related: EntityProfile['related'] = [];
  for (const k of ['actor', 'tenant', 'executor', 'target'] as const) {
    if (k === kind) continue;
    const target = k === 'target',
      idCol = target ? "concat(t.1,':',t.2)" : `${k}_id`,
      nameCol = target ? 't.3' : `${k}_name`,
      typeCol = target ? 't.1' : k === 'tenant' ? "''" : `${k}_type`;
    const rs = await read<{ id: string; name: string; type: string; count: number }>(
      ch,
      `SELECT ${idCol} id,any(${nameCol}) name,${target ? typeCol : `any(${typeCol})`} type,count() count FROM events ${target ? 'ARRAY JOIN arrayZip(target_types,target_ids,target_names) AS t' : ''} WHERE ${w.sql} AND ${idCol}!='' GROUP BY id${target ? ',type' : ''} ORDER BY count DESC LIMIT 10`,
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
/** Scoped exports (#138): the scope predicate is ANDed into every page; `map` applies field masks before encoding. */
export type ExportScope = { scope?: ReadScope | null; map?: (event: AuditEvent) => AuditEvent };
export async function* exportEvents(
  ch: ClickHouseClient,
  p: string,
  q: ExportQuery,
  plan?: ExportPlan,
  execution?: ExportExecution,
  scoped: ExportScope = {},
) {
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
      scoped.scope,
    );
    if (scoped.map) page.data = page.data.map(scoped.map);
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
 * A DELETE that times out or is cancelled may still be running as a mutation, so its effect is unknown. ClickHouse
 * codes 159 (TIMEOUT_EXCEEDED) and 394 (QUERY_WAS_CANCELLED), or a client-side timeout/abort/reset with no server code.
 * Anything else (syntax, auth, missing table) was rejected before it could run.
 */
function deleteOutcomeUnknown(error: unknown) {
  const code = error && typeof error === 'object' && 'code' in error ? String((error as { code?: unknown }).code) : '';
  if (code === '159' || code === '394') return true;
  if (code && /^\d+$/.test(code)) return false;
  return /timeout|timed out|aborted|socket hang up|ECONNRESET/i.test(error instanceof Error ? error.message : String(error));
}
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
  // Once the first DELETE has run, a storage error or timeout leaves the delete unproven: fail closed with a code the
  // API maps to a retryable 503 (no time-range advice), keeping the storage error as `cause`.
  const unverified = (cause: unknown, attempt: number) => {
    console.error(JSON.stringify({ level: 'error', event: 'clickhouse.delete_unverified', table, projectId, attempt }));
    return Object.assign(new Error(`Could not verify the delete in ${table} (attempt ${attempt}). Retry the operation.`, { cause }), {
      code: 'LOGBIRD_DELETE_UNVERIFIED',
      table,
      attempts: attempt,
    });
  };
  for (let attempt = 1; attempt <= DELETE_ATTEMPTS; attempt++) {
    try {
      await ch.command({
        query: `DELETE FROM ${table} WHERE ${predicate}`,
        query_params: bound,
        clickhouse_settings: { mutations_sync: '2', lightweight_deletes_sync: '2' },
      });
    } catch (error) {
      // A definite rejection of the first DELETE changed nothing: propagate it unchanged. A timeout or cancellation, or
      // any error after an earlier DELETE ran, leaves the outcome unknown.
      if (attempt === 1 && !deleteOutcomeUnknown(error)) throw error;
      throw unverified(error, attempt);
    }
    // Concurrent non-replicated mutations can register out of order and skip rows.
    // Retry with a fresh mutation version, but still fail closed for restored parts
    // that outrank every attempt. Completion alone never proves deletion.
    // The probe binds exactly the DELETE's params (not through read(), which rewrites date keys and turns a timeout
    // into a 422 query-budget error). A filter outside the sort key (sample-data `source`) scans the whole project once
    // nothing matches, so it gets a maintenance budget.
    let rows: { n: number }[];
    try {
      rows = await (
        await ch.query({
          query: `SELECT count() n FROM (SELECT 1 FROM ${table} WHERE ${predicate} LIMIT 1)`,
          query_params: bound,
          format: 'JSONEachRow',
          clickhouse_settings: { max_execution_time: 60 },
        })
      ).json<{ n: number }>();
    } catch (error) {
      throw unverified(error, attempt);
    }
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
