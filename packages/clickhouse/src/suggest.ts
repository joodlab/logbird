import { QUERY_FIELDS, type SuggestResponse, type suggestQuerySchema } from '@trailmark/contracts';
import type { z } from 'zod';
import type { ClickHouseClient } from './client';
export async function suggestValues(ch: ClickHouseClient, p: string, q: z.infer<typeof suggestQuerySchema>): Promise<SuggestResponse> {
  const f = QUERY_FIELDS.find((f) => f.key === q.field || f.aliases?.includes(q.field));
  if (f?.suggest === 'none') return { field: q.field, values: [] };
  const params = { p, prefix: q.prefix ?? '', limit: q.limit, key: q.field.replace(/^(attr|attributes)\./, ''), kind: q.field.split('.')[0] };
  let source: string;
  if (!f)
    source =
      'SELECT arrayJoin(groupUniqArrayMerge(5)(samples)) value,value label,sum(count) count FROM attribute_keys WHERE project_id={p:String} AND key={key:String}';
  else if (f.suggest === 'entities') {
    const name = f.key.endsWith('.name'),
      type = f.key.endsWith('.type');
    const v = name ? 'name' : type ? 'type' : f.key === 'target' ? "substring(entity_id,position(entity_id,':')+1)" : 'entity_id';
    source = `SELECT ${v} value,anyLast(${type ? 'type' : 'name'}) label,sum(events) count FROM entities WHERE project_id={p:String} AND kind={kind:String} GROUP BY value`;
  } else if (f.suggest === 'rollup')
    source = `SELECT ${f.column} value,value label,sum(events) count FROM events_by_minute WHERE project_id={p:String} AND bucket>=now()-INTERVAL 7 DAY GROUP BY value`;
  else
    source = `SELECT ${f.column} value,value label,count() count FROM (SELECT ${f.column} FROM events WHERE project_id={p:String} AND timestamp>=now()-INTERVAL 7 DAY AND timestamp<now() ORDER BY timestamp DESC LIMIT 50000) GROUP BY value`;
  const rows = await (
    await ch.query({
      query: `SELECT value,if(label='',value,label) label,count FROM (${source}) WHERE value!='' AND ({prefix:String}='' OR positionCaseInsensitiveUTF8(concat(value,' ',label),{prefix:String})>0) ORDER BY count DESC,value LIMIT {limit:UInt32}`,
      query_params: params,
      format: 'JSONEachRow',
      clickhouse_settings: { max_execution_time: 2 },
    })
  ).json<{ value: string; label: string; count: number }>();
  return { field: q.field, values: rows.map((r) => ({ ...r, count: Number(r.count) })) };
}
