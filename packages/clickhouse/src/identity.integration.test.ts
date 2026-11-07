import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { createClickHouseClient, insertEvents } from './client';
import { normalizeEvent } from './normalize';
import { exportEvents, getEvent, searchEvents } from './queries';

it('search and export return the version that actually passed the filter, before replacement merges', async () => {
  const db = `qa_immutable_${randomUUID().replaceAll('-', '')}`;
  const admin = createClickHouseClient();
  const ch = createClickHouseClient({ ...process.env, CLICKHOUSE_DATABASE: db });
  const now = new Date();
  try {
    await admin.command({ query: `CREATE DATABASE ${db}` });
    // A disposable MergeTree clone keeps both versions visible, reproducing the pre-merge state deterministically.
    await admin.command({ query: `CREATE TABLE ${db}.events AS events ENGINE=MergeTree ORDER BY (project_id,timestamp,event_id)` });
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
    await admin.command({ query: `DROP DATABASE IF EXISTS ${db}` });
    await admin.close();
  }
}, 30_000);
