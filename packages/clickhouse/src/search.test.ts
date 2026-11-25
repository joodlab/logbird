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
const isCount = (sql: string) => sql.startsWith('SELECT count() n FROM (SELECT DISTINCT event_id');
// The row and count statements run concurrently: answer and inspect each by purpose, never by call order.
function client(rows: ReturnType<typeof row>[], total: number | Error = rows.length) {
  const query = vi.fn(async (args: { query: string }) => {
    if (!isCount(args.query)) return { json: async () => rows, close: vi.fn() };
    if (total instanceof Error) throw total;
    return { json: async () => [{ n: total }], close: vi.fn() };
  });
  const call = (count: boolean) =>
    query.mock.calls.find(([args]) => isCount(args.query) === count)?.[0] as { query: string; query_params: Record<string, unknown> };
  return { ch: { query } as unknown as ClickHouseClient, query, rowCall: () => call(false), countCall: () => call(true) };
}
it.each(['asc', 'desc'] as const)('keeps the %s selector in sort-key order and resolves receipts only in its bounded page', async (order) => {
  const a = row('first', '2026-11-07T10:01:00.000Z'),
    b = row('second', '2026-11-07T10:02:00.000Z');
  const rows = order === 'asc' ? [a, b] : [b, a];
  const { ch, rowCall } = client(rows, 5);
  const page = await searchEvents(ch, 'qa-narrow-search', { from, to, order, limit: 1, q: 'target:record tenant:tenant' });
  const sql = rowCall().query;
  const inner = sql.slice(sql.indexOf(' IN (') + 5, sql.lastIndexOf(') ORDER BY'));
  expect(inner).toMatch(/^SELECT timestamp,event_id FROM events WHERE project_id=/);
  expect(inner).not.toMatch(/received_at|SELECT \*|payload|search_text/);
  expect(inner).toContain(`ORDER BY timestamp ${order.toUpperCase()},event_id ${order.toUpperCase()} LIMIT 1 BY event_id LIMIT {limit:UInt32}`);
  expect(sql).toContain('(timestamp,event_id) IN (');
  expect(sql).toMatch(/ORDER BY timestamp (?:ASC|DESC),event_id (?:ASC|DESC),received_at ASC LIMIT 1 BY event_id LIMIT \{limit:UInt32\}$/);
  expect(rowCall().query_params).toMatchObject({ project: 'qa-narrow-search', limit: 2 });
  expect(page.data.map((e) => e.id)).toEqual([rows[0]?.event_id]);
  expect(page.total).toBe(5);
  expect(JSON.parse(Buffer.from(page.nextCursor as string, 'base64url').toString()).slice(0, 2)).toEqual([rows[0]?.timestamp, rows[0]?.event_id]);
});
it.each(['asc', 'desc'] as const)('applies the %s cursor inside the narrow selector and does not advance past the sentinel', async (order) => {
  const at = '2026-11-07T10:01:00.000Z';
  const next = row('b', at);
  const { ch, rowCall, countCall } = client([next], 3);
  const cursorId = order === 'asc' ? 'a' : 'z';
  const cursor = Buffer.from(JSON.stringify([at, cursorId])).toString('base64url');
  const page = await searchEvents(ch, 'qa-narrow-search', { from, to, order, limit: 1, cursor });
  expect(page.nextCursor).toBeNull();
  expect(page.data.map((e) => e.id)).toEqual(['b']);
  const sql = rowCall().query;
  expect(sql).toContain(`AND (timestamp,event_id) ${order === 'asc' ? '>' : '<'} ({cursorTs:DateTime64(3, 'UTC')},{cursorId:String}) ORDER BY`);
  expect(sql.indexOf('{cursorTs:')).toBeGreaterThan(sql.indexOf(' IN (SELECT timestamp'));
  expect(rowCall().query_params).toMatchObject({ cursorTs: '2026-11-07 10:01:00.000', cursorId });
  const countSql = countCall().query;
  expect(countSql).not.toContain('cursorTs');
  expect(countSql).toContain('SELECT DISTINCT event_id');
});
it.each(['asc', 'desc'] as const)('rechecks %s filters before deduping legacy rows that share the entire pointer', async (order) => {
  for (const [q, predicate] of [
    ['action:wanted', 'action = {q0:String}'],
    ['tenant:wanted', 'tenant_id = {q0:String}'],
    ['target:wanted', 'arrayExists(x -> x = {q0:String}, target_ids)'],
  ] as const) {
    const { ch, rowCall } = client([]);
    await searchEvents(ch, 'qa-narrow-search', { from, to, order, limit: 1, q });
    const sql = rowCall().query;
    const outer = sql.slice(0, sql.indexOf(' IN (SELECT'));
    expect(outer).toContain(predicate);
    expect(sql.split(predicate)).toHaveLength(3);
    expect(sql).toContain('(timestamp,event_id) IN (SELECT timestamp,event_id');
    expect(rowCall().query_params).toMatchObject({ q0: 'wanted', limit: 2 });
  }
});
it('never reports a total below the rows a page proves, and marks a failed count as a lower bound', async () => {
  const a = row('a', '2026-11-07T10:01:00.000Z'),
    b = row('b', '2026-11-07T10:02:00.000Z'),
    c = row('c', '2026-11-07T10:03:00.000Z');
  // The count ran against an earlier snapshot and saw nothing; the page proves at least three.
  const stale = await searchEvents(client([c, b, a], 0).ch, 'qa-narrow-search', { from, to, order: 'desc', limit: 2 });
  expect(stale).toMatchObject({ total: 3, totalExact: false });
  const failed = await searchEvents(client([c, b, a], new Error('fictional count failure')).ch, 'qa-narrow-search', {
    from,
    to,
    order: 'desc',
    limit: 2,
  });
  expect(failed.data.map((e) => e.id)).toEqual(['c', 'b']);
  expect(failed).toMatchObject({ total: 3, totalExact: false });
  expect(await searchEvents(client([b, a], 2).ch, 'qa-narrow-search', { from, to, order: 'desc', limit: 5 })).toMatchObject({
    total: 2,
    totalExact: true,
  });
  expect(await searchEvents(client([b], 10_001).ch, 'qa-narrow-search', { from, to, order: 'desc', limit: 5 })).toMatchObject({
    total: 10_001,
    totalExact: false,
  });
});
it('settles a stalled count body by its deadline and closes the stream', async () => {
  const b = row('b', '2026-11-07T10:02:00.000Z');
  const close = vi.fn();
  const query = vi.fn(async (args: { query: string }) =>
    isCount(args.query) ? { json: () => new Promise(() => undefined), close } : { json: async () => [b], close: vi.fn() },
  );
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const started = Date.now();
  const page = await searchEvents({ query } as unknown as ClickHouseClient, 'qa-narrow-search', { from, to, order: 'desc', limit: 5 });
  expect(Date.now() - started).toBeLessThan(1500);
  expect(page).toMatchObject({ total: 1, totalExact: false });
  expect(close).toHaveBeenCalled();
  expect(warn.mock.calls.map(([line]) => JSON.parse(String(line)).reason)).toEqual(['budget']);
  warn.mockRestore();
});
it('runs the count only after the rows, and never when the rows fail', async () => {
  const b = row('b', '2026-11-07T10:02:00.000Z');
  const order: string[] = [];
  let rowsDone = false;
  const query = vi.fn(async (args: { query: string }) => {
    order.push(isCount(args.query) ? `count(rowsDone=${rowsDone})` : 'rows');
    if (isCount(args.query)) return { json: async () => [{ n: 1 }], close: vi.fn() };
    return {
      json: async () => {
        rowsDone = true;
        return [b];
      },
      close: vi.fn(),
    };
  });
  expect(await searchEvents({ query } as unknown as ClickHouseClient, 'qa-narrow-search', { from, to, order: 'desc', limit: 5 })).toMatchObject({
    total: 1,
    totalExact: true,
  });
  expect(order).toEqual(['rows', 'count(rowsDone=true)']);
  const failing = vi.fn(async (args: { query: string }) => {
    if (isCount(args.query)) throw new Error('count must not run');
    throw Object.assign(new Error('Too many simultaneous queries.'), { code: '202', type: 'TOO_MANY_SIMULTANEOUS_QUERIES' });
  });
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  await expect(
    searchEvents({ query: failing } as unknown as ClickHouseClient, 'qa-narrow-search', { from, to, order: 'desc', limit: 5 }),
  ).rejects.toThrow('Too many simultaneous queries.');
  expect(failing).toHaveBeenCalledTimes(1);
  expect(warn).not.toHaveBeenCalled();
  warn.mockRestore();
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
  expect(query.mock.calls[0]?.[0].query).toMatch(/ORDER BY received_at,timestamp,sipHash64\(payload\) LIMIT 1$/);
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

it('#180: binds every new cursor to its project, keeps legacy two-part cursors for unscoped reads, rejects bad positions', async () => {
  const at = '2026-11-07T10:01:00.000Z';
  const page = async (project: string, cursor?: string, scope?: { tenantId: string } | null) => {
    const { ch } = client([row('a', at), row('b', at)], 2);
    return searchEvents(ch, project, { from, to, order: 'desc', limit: 1, cursor }, undefined, scope);
  };
  const first = (await page('qa-cursor-a')).nextCursor as string;
  const parts = JSON.parse(Buffer.from(first, 'base64url').toString()) as string[];
  expect(parts).toHaveLength(3);
  expect(parts[2]).toMatch(/^u\./);
  await expect(page('qa-cursor-a', first)).resolves.toBeTruthy();
  // Replayed in another project: refused, even though both readers are unscoped.
  await expect(page('qa-cursor-b', first)).rejects.toThrow('Invalid cursor');
  // A scoped reader never accepts an unscoped cursor, and vice versa.
  await expect(page('qa-cursor-a', first, { tenantId: 't1' })).rejects.toThrow('Invalid cursor');
  const scoped = (await page('qa-cursor-a', undefined, { tenantId: 't1' })).nextCursor as string;
  await expect(page('qa-cursor-a', scoped)).rejects.toThrow('Invalid cursor');
  // Legacy two-part cursors keep working for unscoped readers only.
  const legacy = Buffer.from(JSON.stringify([at, 'z'])).toString('base64url');
  await expect(page('qa-cursor-a', legacy)).resolves.toBeTruthy();
  await expect(page('qa-cursor-a', legacy, { tenantId: 't1' })).rejects.toThrow('Invalid cursor');
  for (const bad of [
    ['2026-02-30T10:00:00.000Z', 'x'], // calendar overflow
    ['2026-11-07T10:00:00Z', 'x'], // no milliseconds: not a position this API issued
    ['not-a-date', 'x'],
    [at, ''], // empty id
  ])
    await expect(page('qa-cursor-a', Buffer.from(JSON.stringify(bad)).toString('base64url')), JSON.stringify(bad)).rejects.toThrow('Invalid cursor');
});
it('states the window its rows and count used, explicit or by default, from one clock', async () => {
  const explicit = client([], 0);
  const page = await searchEvents(explicit.ch, 'qa-narrow-search', { from: '2026-11-07T12:00:00+02:00', to, order: 'desc', limit: 5 });
  expect(page.range).toEqual({ from, to });
  // Parameters reach ClickHouse as DateTime64 text: the same instants.
  const sent = (r: { from: string; to: string }) => ({ from: r.from.replace('T', ' ').slice(0, -1), to: r.to.replace('T', ' ').slice(0, -1) });
  for (const call of [explicit.rowCall(), explicit.countCall()]) expect(call.query_params).toMatchObject(sent({ from, to }));
  vi.useFakeTimers({ now: Date.parse('2026-11-08T09:30:00.123Z'), toFake: ['Date'] });
  try {
    const fallback = client([], 0);
    const window = await searchEvents(fallback.ch, 'qa-narrow-search', { order: 'desc', limit: 5 });
    expect(window.range).toEqual({ from: '2026-11-07T09:30:00.123Z', to: '2026-11-08T09:30:00.123Z' });
    for (const call of [fallback.rowCall(), fallback.countCall()]) expect(call.query_params).toMatchObject(sent(window.range));
  } finally {
    vi.useRealTimers();
  }
});
