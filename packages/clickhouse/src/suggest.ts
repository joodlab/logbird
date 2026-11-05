import { QUERY_FIELDS, type SuggestResponse, type suggestQuerySchema } from '@trailmark/contracts';
import type { z } from 'zod';
import type { ClickHouseClient } from './client';
import { read, where } from './queries';

export async function suggestValues(ch: ClickHouseClient, p: string, q: z.infer<typeof suggestQuerySchema>): Promise<SuggestResponse> {
  const f = QUERY_FIELDS.find((f) => f.key === q.field || f.aliases?.includes(q.field));
  if (f?.suggest === 'none') return { field: q.field, values: [], complete: true };
  const scoped = !!(q.q?.trim() || q.from || q.to);
  const params: Record<string, unknown> = {
    p,
    prefix: q.prefix ?? '',
    limit: q.limit + 1,
    key: q.field.replace(/^(attr|attributes)\./, ''),
    kind: (f?.key ?? q.field).split('.')[0],
  };
  let source: string;
  let sample: string | undefined;
  if (scoped || !f || f.suggest === 'column') {
    const to = q.to ?? new Date().toISOString();
    const w = await where(ch, p, { ...q, to, from: q.from ?? new Date(new Date(to).getTime() - 7 * 86_400_000).toISOString() });
    Object.assign(params, w.params);
    // Select recent rows first, then filter. This bounds attribute scans even for rare predicates.
    sample =
      'SELECT * FROM events WHERE project_id={project:String} AND timestamp>={from:DateTime64(3)} AND timestamp<{to:DateTime64(3)} ORDER BY timestamp DESC,event_id DESC LIMIT 50001';
    const events = `(SELECT * FROM (${sample}) LIMIT 50000)`;
    const value = !f ? 'attributes[{key:String}]' : f.type === 'array' ? `arrayJoin(${f.column})` : f.column;
    const kind = f?.key.split('.')[0];
    const label = f?.suggest === 'entities' && !f.key.includes('.') && ['actor', 'tenant', 'executor'].includes(kind ?? '') ? `${kind}_name` : value;
    source = `SELECT ${value} value,anyLast(${label}) label,count() count FROM ${events} WHERE (${w.sql}) ${!f ? 'AND mapContains(attributes,{key:String})' : ''} GROUP BY value`;
  } else if (f.suggest === 'entities') {
    const name = f.key.endsWith('.name'),
      type = f.key.endsWith('.type');
    const v = name ? 'name' : type ? 'type' : f.key === 'target' ? "substring(entity_id,position(entity_id,':')+1)" : 'entity_id';
    source = `SELECT ${v} value,anyLast(${type ? 'type' : 'name'}) label,sum(events) count FROM entities WHERE project_id={p:String} AND kind={kind:String} GROUP BY value`;
  } else {
    source = `SELECT ${f.column} value,value label,sum(events) count FROM events_by_minute WHERE project_id={p:String} AND bucket>=now()-INTERVAL 7 DAY GROUP BY value`;
  }
  const valuesQuery = `SELECT value,if(label='',value,label) label,count FROM (${source}) WHERE value!='' AND ({prefix:String}='' OR positionCaseInsensitiveUTF8(concat(value,' ',label),{prefix:String})>0) ORDER BY count DESC,value LIMIT {limit:UInt32}`;
  let rows: { value: string; label: string; count: number }[];
  let exhaustive = true;
  if (sample) {
    // One round trip, including the overflow probe, even when no values match.
    const [result] = await read<{ matches: [string, string, number][]; scanned: number }>(
      ch,
      `SELECT groupArray((value,label,count)) matches,(SELECT count() FROM (${sample})) scanned FROM (${valuesQuery})`,
      params,
      2,
    );
    rows = (result?.matches ?? []).map(([value, label, count]) => ({ value, label, count }));
    exhaustive = Number(result?.scanned ?? 0) <= 50_000;
  } else rows = await read(ch, valuesQuery, params, 2);
  return {
    field: q.field,
    values: rows.slice(0, q.limit).map((r) => ({ ...r, count: Number(r.count) })),
    complete: exhaustive && rows.length <= q.limit,
  };
}
