import { expect, it, vi } from 'vitest';
import type { ClickHouseClient } from './client';
import { normalizeEvent } from './normalize';
import { getEvent, hasExpiredEvents, searchEvents } from './queries';

const from = '2026-11-07T10:00:00.000Z',
  to = '2026-11-07T11:00:00.000Z';
function row(id: string, timestamp: string, receivedAt = timestamp) {
  const n = normalizeEvent(
    { id, action: 'matching.event', occurredAt: timestamp },
    { projectId: 'qa-narrow-search', receivedAt: new Date(receivedAt) },
  );
  if (!n.ok) throw new Error(n.reason);
  return n.row;
}
function client(rows: ReturnType<typeof row>[], total = rows.length) {
  const query = vi
    .fn()
    .mockResolvedValueOnce({ json: async () => rows })
    .mockResolvedValueOnce({ json: async () => [{ n: total }] });
  return { ch: { query } as unknown as ClickHouseClient, query };
}
it.each(['asc', 'desc'] as const)('keeps the %s selector in sort-key order and resolves receipts only in its bounded page', async (order) => {
  const a = row('first', '2026-11-07T10:01:00.000Z'),
    b = row('second', '2026-11-07T10:02:00.000Z');
  const rows = order === 'asc' ? [a, b] : [b, a];
  const { ch, query } = client(rows, 5);
  const page = await searchEvents(ch, 'qa-narrow-search', { from, to, order, limit: 1, q: 'target:record tenant:tenant' });
  const sql = query.mock.calls[0]?.[0].query as string;
  const inner = sql.slice(sql.indexOf(' IN (') + 5, sql.lastIndexOf(') ORDER BY'));
  expect(inner).toMatch(/^SELECT timestamp,event_id FROM events WHERE project_id=/);
  expect(inner).not.toMatch(/received_at|SELECT \*|payload|search_text/);
  expect(inner).toContain(`ORDER BY timestamp ${order.toUpperCase()},event_id ${order.toUpperCase()} LIMIT 1 BY event_id LIMIT {limit:UInt32}`);
  expect(sql).toContain('(timestamp,event_id) IN (');
  expect(sql).toMatch(/ORDER BY timestamp (?:ASC|DESC),event_id (?:ASC|DESC),received_at ASC LIMIT 1 BY event_id LIMIT \{limit:UInt32\}$/);
  expect(query.mock.calls[0]?.[0].query_params).toMatchObject({ project: 'qa-narrow-search', limit: 2 });
  expect(page.data.map((e) => e.id)).toEqual([rows[0]?.event_id]);
  expect(page.total).toBe(5);
  expect(JSON.parse(Buffer.from(page.nextCursor as string, 'base64url').toString())).toEqual([rows[0]?.timestamp, rows[0]?.event_id]);
});
it.each(['asc', 'desc'] as const)('applies the %s cursor inside the narrow selector and does not advance past the sentinel', async (order) => {
  const at = '2026-11-07T10:01:00.000Z';
  const next = row('b', at);
  const { ch, query } = client([next], 3);
  const cursorId = order === 'asc' ? 'a' : 'z';
  const cursor = Buffer.from(JSON.stringify([at, cursorId])).toString('base64url');
  const page = await searchEvents(ch, 'qa-narrow-search', { from, to, order, limit: 1, cursor });
  expect(page.nextCursor).toBeNull();
  expect(page.data.map((e) => e.id)).toEqual(['b']);
  const sql = query.mock.calls[0]?.[0].query as string;
  expect(sql).toContain(`AND (timestamp,event_id) ${order === 'asc' ? '>' : '<'} ({cursorTs:DateTime64(3)},{cursorId:String}) ORDER BY`);
  expect(sql.indexOf('{cursorTs:')).toBeGreaterThan(sql.indexOf(' IN (SELECT timestamp'));
  expect(query.mock.calls[0]?.[0].query_params).toMatchObject({ cursorTs: '2026-11-07 10:01:00.000', cursorId });
  const countSql = query.mock.calls[1]?.[0].query as string;
  expect(countSql).not.toContain('cursorTs');
  expect(countSql).toContain('SELECT DISTINCT event_id');
});
it.each(['asc', 'desc'] as const)('rechecks %s filters before deduping legacy rows that share the entire pointer', async (order) => {
  for (const [q, predicate] of [
    ['action:wanted', 'action = {q0:String}'],
    ['tenant:wanted', 'tenant_id = {q0:String}'],
    ['target:wanted', 'arrayExists(x -> x = {q0:String}, target_ids)'],
  ] as const) {
    const { ch, query } = client([]);
    await searchEvents(ch, 'qa-narrow-search', { from, to, order, limit: 1, q });
    const sql = query.mock.calls[0]?.[0].query as string;
    const outer = sql.slice(0, sql.indexOf(' IN (SELECT'));
    expect(outer).toContain(predicate);
    expect(sql.split(predicate)).toHaveLength(3);
    expect(sql).toContain('(timestamp,event_id) IN (SELECT timestamp,event_id');
    expect(query.mock.calls[0]?.[0].query_params).toMatchObject({ q0: 'wanted', limit: 2 });
  }
});
it('returns no cursor for an empty page', async () => {
  const { ch } = client([], 0);
  expect(await searchEvents(ch, 'qa-narrow-search', { from, to, order: 'desc', limit: 5 })).toMatchObject({ data: [], total: 0, nextCursor: null });
});
it('detail keeps oldest receipt first, with timestamp as its deterministic tie breaker', async () => {
  const original = row('same', '2026-11-07T10:02:00.000Z', '2026-11-07T10:03:00.000Z');
  const query = vi
    .fn()
    .mockResolvedValueOnce({ json: async () => [original] })
    .mockResolvedValueOnce({ json: async () => [{ children: 0, size: 0 }] });
  const result = await getEvent({ query } as unknown as ClickHouseClient, 'qa-narrow-search', 'same');
  expect(query.mock.calls[0]?.[0].query).toMatch(/ORDER BY received_at,timestamp LIMIT 1$/);
  expect(result?.event.receivedAt).toBe('2026-11-07T10:03:00.000Z');
});
it('expiration probes stay narrow and bounded in both raw rows and the identity index', async () => {
  const query = vi.fn().mockResolvedValue({ json: async () => [{ n: 1 }] });
  expect(await hasExpiredEvents({ query } as unknown as ClickHouseClient, 'qa-narrow-search', new Date(from))).toBe(true);
  const sql = query.mock.calls[0]?.[0].query as string;
  expect(sql.match(/SELECT 1 FROM/g)).toHaveLength(2);
  expect(sql.match(/LIMIT 1/g)).toHaveLength(2);
  expect(sql).not.toContain('SELECT *');
});
