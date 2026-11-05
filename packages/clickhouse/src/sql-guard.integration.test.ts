import { afterAll, describe, expect, it } from 'vitest';
import { createClickHouseClient, createQueryClickHouseClient, insertEvents } from './client';
import { normalizeEvent } from './normalize';
import { exportEvents, facets, histogram, searchEvents } from './queries';
import { validateSql } from './sql-guard';

const enabled = !!process.env.CLICKHOUSE_QUERY_PASSWORD;
const ch = enabled ? createClickHouseClient() : null,
  restricted = enabled ? createQueryClickHouseClient() : null;
afterAll(async () => {
  await ch?.close();
  await restricted?.close();
});

import { attacks, positives } from '../test-fixtures/sql';

describe.runIf(enabled)('real ClickHouse SQL guard', () => {
  it.each(attacks)('rejects %s', async (q) => {
    await expect(validateSql(restricted!, q)).rejects.toThrow();
  });
  it.each(positives)('accepts %s', async (q) => {
    expect(await validateSql(restricted!, q)).toBe(q);
  });
  it('maps SQL syntax byte positions to UTF-16', async () => {
    const q = "action = '\u00e9' AND @ foo";
    await expect(validateSql(restricted!, q)).rejects.toMatchObject({
      details: { reason: 'syntax', start: q.indexOf('@'), end: q.indexOf('@') + 1 },
    });
  });
  it.each([
    ["action = 'sleep(' AND sleep(3) = 0", 'sleep(', 'not_allowed'],
    ["outcome = 'project_id' OR project_id = 'x'", 'project_id', 'unknown_field'],
    ['event_id IN (SELECT event_id FROM events)', 'SELECT', 'not_allowed'],
  ])('points %s at the offending token, outside string literals', async (q, token, reason) => {
    const start = q.lastIndexOf(token);
    const error = await validateSql(restricted!, q).catch((e) => e);
    expect(error.details).toMatchObject({ reason, start, end: start + token.length });
    expect(error.details.hint).not.toBe(error.message);
  });
  it('reports validator latency separately from a cache hit', async () => {
    const q = `action = 'latency-${Date.now()}'`;
    const a = performance.now();
    await validateSql(restricted!, q);
    const b = performance.now();
    await validateSql(restricted!, q);
    console.log(JSON.stringify({ validationMs: b - a, cachedMs: performance.now() - b }));
  });
  it('restricted user cannot read protected tables or write', async () => {
    for (const query of [
      'SELECT * FROM system.users',
      'SELECT * FROM default.no_such_table',
      "INSERT INTO trailmark.events (action) VALUES ('x')",
      'CREATE TABLE trailmark.forbidden (x UInt8) ENGINE=Memory',
    ])
      await expect(restricted?.query({ query })).rejects.toThrow();
  });
  it('keeps project/time boundaries through search, histogram, facets and export', async () => {
    const p = 'search-v2-fixture-a',
      other = 'search-v2-fixture-b',
      now = new Date();
    for (const projectId of [p, other]) {
      const r = normalizeEvent({ id: projectId, action: 'search.fixture', occurredAt: now.toISOString() }, { projectId, receivedAt: now });
      if (!r.ok) throw new Error('fixture normalization');
      await insertEvents(ch!, [r.row]);
    }
    const q = {
      lang: 'sql' as const,
      q: '1 OR 1',
      from: new Date(now.getTime() - 1000).toISOString(),
      to: new Date(now.getTime() + 1000).toISOString(),
    };
    const result = await searchEvents(restricted!, p, { ...q, limit: 50, order: 'desc' });
    expect(result.data.map((e) => e.projectId)).toEqual([p]);
    expect((await histogram(restricted!, p, q)).buckets.reduce((a, b) => a + b.total, 0)).toBe(1);
    expect((await facets(restricted!, p, { ...q, field: 'action', limit: 10 })).values).toEqual([
      { value: 'search.fixture', label: 'search.fixture', count: 1 },
    ]);
    let output = '';
    for await (const line of exportEvents(restricted!, p, { ...q, format: 'jsonl' })) output += line;
    expect(output).toContain(p);
    expect(output).not.toContain(other);
  });
});
