import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { createClickHouseClient, insertEvents } from './client';
import { normalizeEvent } from './normalize';
import { exportEvents, getEvent, searchEvents } from './queries';

it('search and export return the version that actually passed the filter, before replacement merges', async () => {
  const table = `qa_immutable_${randomUUID().replaceAll('-', '')}`;
  const admin = createClickHouseClient();
  const ch = createClickHouseClient();
  const query = ch.query.bind(ch),
    insert = ch.insert.bind(ch);
  ch.query = (params) => query({ ...params, query: params.query.replaceAll(/\bFROM events\b/g, `FROM ${table}`) });
  ch.insert = (params) => insert({ ...params, table: params.table === 'events' ? table : params.table });
  const now = new Date();
  try {
    // A disposable MergeTree clone keeps both versions visible, reproducing the pre-merge state deterministically.
    await admin.command({ query: `CREATE TABLE ${table} AS events ENGINE=MergeTree ORDER BY (project_id,timestamp,event_id)` });
    for (const [index, action] of ['evidence.original', 'evidence.replacement'].entries()) {
      const row = normalizeEvent(
        { id: 'same', action, occurredAt: now.toISOString() },
        { projectId: 'fictional', receivedAt: new Date(now.getTime() + index * 1000) },
      );
      if (!row.ok) throw new Error('Invalid fixture');
      await insertEvents(ch, [row.row]);
    }
    const q = {
      from: new Date(now.getTime() - 1000).toISOString(),
      to: new Date(now.getTime() + 1000).toISOString(),
      limit: 10,
      order: 'asc' as const,
    };
    for (const action of ['evidence.original', 'evidence.replacement']) {
      const filtered = { ...q, q: `action:${action}` };
      const found = await searchEvents(ch, 'fictional', filtered);
      expect(found.data.map((e) => e.action)).toEqual([action]);
      const lines: string[] = [];
      for await (const line of exportEvents(ch, 'fictional', { ...filtered, format: 'jsonl' })) lines.push(JSON.parse(line).action);
      expect(lines).toEqual([action]);
    }
    expect((await getEvent(ch, 'fictional', 'same'))?.event.action).toBe('evidence.original');
  } finally {
    await ch.close();
    await admin.command({ query: `DROP TABLE IF EXISTS ${table} SYNC` });
    await admin.close();
  }
}, 30_000);

it.each(['asc', 'desc'] as const)(
  'narrow %s pages preserve matching legacy pointers, receipt ties and cursor boundaries',
  async (order) => {
    const table = `qa_immutable_${randomUUID().replaceAll('-', '')}`;
    const admin = createClickHouseClient(),
      ch = createClickHouseClient();
    const query = ch.query.bind(ch),
      insert = ch.insert.bind(ch);
    ch.query = (params) => query({ ...params, query: params.query.replaceAll(/\bFROM events\b/g, `FROM ${table}`) });
    ch.insert = (params) => insert({ ...params, table: params.table === 'events' ? table : params.table });
    const now = new Date();
    const at = (ms: number) => new Date(now.getTime() + ms).toISOString();
    const make = (id: string, eventMs: number, receiptMs: number, action: string) => {
      const n = normalizeEvent(
        { id, action, occurredAt: at(eventMs), tenant: { id: action }, targets: [{ id: action, type: 'record' }] },
        { projectId: 'fictional', receivedAt: new Date(at(receiptMs)) },
      );
      if (!n.ok) throw new Error(n.reason);
      return n.row;
    };
    try {
      await admin.command({ query: `CREATE TABLE ${table} AS events ENGINE=MergeTree ORDER BY(project_id,timestamp,event_id)` });
      // A MergeTree clone retains every historical version, independent of background replacement merges.
      await insertEvents(ch, [
        make('one', 0, 200, 'one.replacement'),
        make('legacy', 3000, 900, 'legacy.replacement'),
        make('three', 1000, 300, 'three'),
        make('legacy', -1000, 800, 'legacy.early_time'),
        make('two', 0, 200, 'two'),
        make('one', 0, 100, 'one.original'),
        make('legacy', 3000, 500, 'legacy.original'),
      ]);
      const q = { from: at(-10_000), to: at(10_000), limit: 10, order };
      const all = await searchEvents(ch, 'fictional', q);
      expect(all.total).toBe(4);
      expect(all.nextCursor).toBeNull();
      expect(all.data.map((e) => e.action)).toEqual(
        order === 'asc' ? ['legacy.early_time', 'one.original', 'two', 'three'] : ['legacy.original', 'three', 'two', 'one.original'],
      );
      for (const action of ['one.replacement', 'legacy.replacement']) {
        const result = await searchEvents(ch, 'fictional', { ...q, q: `action:${action}` });
        expect(result.data.map((e) => e.action)).toEqual([action]);
      }
      expect((await getEvent(ch, 'fictional', 'legacy'))?.event.action).toBe('legacy.original');
      expect((await getEvent(ch, 'fictional', 'one'))?.event.action).toBe('one.original');
      const ids: string[] = [];
      let cursor: string | undefined;
      for (let pageIndex = 0; pageIndex < 3; pageIndex++) {
        const result = await searchEvents(ch, 'fictional', { ...q, q: '-id:legacy', limit: 1, cursor });
        expect(result.total).toBe(3);
        expect(result.data).toHaveLength(1);
        const event = result.data[0];
        if (!event) throw new Error('Missing page row');
        ids.push(event.id);
        expect(!!result.nextCursor).toBe(pageIndex < 2);
        if (result.nextCursor) expect(JSON.parse(Buffer.from(result.nextCursor, 'base64url').toString())).toEqual([event.timestamp, event.id]);
        cursor = result.nextCursor ?? undefined;
      }
      expect(ids).toEqual(order === 'asc' ? ['one', 'two', 'three'] : ['three', 'two', 'one']);
      expect(new Set(ids).size).toBe(3);
      // Legacy ids can span timestamps: cursor filtering precedes page-local dedupe, as documented.
      const boundary = order === 'asc' ? [at(0), 'two'] : [at(1000), 'three'];
      const after = await searchEvents(ch, 'fictional', { ...q, cursor: Buffer.from(JSON.stringify(boundary)).toString('base64url') });
      expect(after.data.map((e) => e.action)).toEqual(order === 'asc' ? ['three', 'legacy.original'] : ['two', 'one.original', 'legacy.early_time']);
    } finally {
      await ch.close();
      await admin.command({ query: `DROP TABLE IF EXISTS ${table} SYNC` });
      await admin.close();
    }
  },
  60_000,
);
