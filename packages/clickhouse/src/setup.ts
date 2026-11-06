import { ENVELOPE_FIELDS, SAMPLE_DATA_SOURCES, SETUP_ENVELOPE_SAMPLE } from '@logbird/contracts';
import type { ClickHouseClient } from './client';
import type { EventRow } from './normalize';
import { toEvent } from './queries';

export async function setupEventFacts(ch: ClickHouseClient, project: string) {
  const params = { project, source: SAMPLE_DATA_SOURCES, limit: SETUP_ENVELOPE_SAMPLE };
  const read = async <T>(query: string) =>
    (await ch.query({ query, query_params: params, format: 'JSONEachRow', clickhouse_settings: { max_execution_time: 10 } })).json<T>();
  // Lifetime facts necessarily span all retained partitions. PREWHERE prunes by project;
  // arrival times (not client timestamps) define first/last/recent ingestion.
  const [counts, first, sample] = await Promise.all([
    read<{ recent: string; samples: string; last: string | null }>(
      `SELECT countIf(source NOT IN {source:Array(String)} AND received_at>=now()-INTERVAL 24 HOUR) recent,countIf(source IN {source:Array(String)}) samples,maxOrNullIf(received_at,source NOT IN {source:Array(String)}) last FROM events PREWHERE project_id={project:String} AND timestamp>=toDateTime64('1900-01-01',3)`,
    ),
    read<EventRow>(
      `SELECT * FROM events PREWHERE project_id={project:String} AND timestamp>=toDateTime64('1900-01-01',3) WHERE source NOT IN {source:Array(String)} ORDER BY received_at,event_id LIMIT 1`,
    ),
    read<{ n: string; avg: number; operations: string } & Record<(typeof ENVELOPE_FIELDS)[number], number>>(
      `SELECT count() n,ifNotFinite(avg(conformance),0) avg,countIf(operation_id!='') operations,${[
        "actor_id!=''",
        "tenant_id!=''",
        "executor_id!='' OR executor_type!=''",
        'length(target_ids)>0',
        "JSONHas(payload,'outcome')",
        "JSONHas(payload,'occurredAt')",
      ]
        .map((expr, i) => `ifNotFinite(avg(${expr}),0) ${ENVELOPE_FIELDS[i]}`)
        .join(
          ',',
        )} FROM (SELECT conformance,operation_id,actor_id,tenant_id,executor_id,executor_type,target_ids,payload FROM events PREWHERE project_id={project:String} AND timestamp>=toDateTime64('1900-01-01',3) WHERE received_at>=now()-INTERVAL 7 DAY AND source NOT IN {source:Array(String)} ORDER BY received_at DESC,event_id DESC LIMIT {limit:UInt32})`,
    ),
  ]);
  const row = counts[0];
  const envelope = sample[0];
  const firstEvent = first[0] ? toEvent(first[0]) : null;
  return {
    firstEvent,
    firstEventAt: firstEvent?.receivedAt ?? null,
    lastEventAt: row?.last ? new Date(`${row.last.replace(' ', 'T')}Z`).toISOString() : null,
    eventsLast24h: Number(row?.recent ?? 0),
    sampleEvents: Number(row?.samples ?? 0),
    sampledEvents: Number(envelope?.n ?? 0),
    avgConformance: Number(envelope?.avg ?? 0),
    eventsWithOperationId: Number(envelope?.operations ?? 0),
    fields: ENVELOPE_FIELDS.map((field) => ({ field, coverage: Number(envelope?.[field] ?? 0) })),
  };
}
export type SetupEventFacts = Awaited<ReturnType<typeof setupEventFacts>>;
