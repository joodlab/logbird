import { expect, it, vi } from 'vitest';
import { createQueryClickHouseClient } from './client';
import { read, where } from './queries';
import { sqlSyntaxError } from './sql-guard';

vi.mock('./sql-guard', async (original) => ({ ...(await original<object>()), validateSql: async (_ch: unknown, q: string) => q }));

it('maps execution-time SQL byte positions to expression UTF-16 offsets', async () => {
  const ch = createQueryClickHouseClient({ CLICKHOUSE_QUERY_USER: 'fixture', CLICKHOUSE_QUERY_PASSWORD: 'fixture' });
  if (!ch) throw new Error('Fixture client');
  const expression = "description = '\u0639' AND action =";
  const w = await where(ch, 'fictional-project', { q: expression, lang: 'sql' });
  const statement = `SELECT event_id FROM events WHERE ${w.sql}`;
  const offset = statement.indexOf(expression) + expression.length;
  const error = new Error(`SYNTAX_ERROR: Syntax error at position ${Buffer.byteLength(statement.slice(0, offset)) + 1}`);
  vi.spyOn(ch, 'query').mockRejectedValue(error);
  await expect(read(ch, statement, w.params)).rejects.toMatchObject({
    details: { lang: 'sql', reason: 'syntax', start: expression.length, end: expression.length },
  });
  await ch.close();
});
it('preserves the caller time parameters across repeated reads', async () => {
  const ch = createQueryClickHouseClient({ CLICKHOUSE_QUERY_USER: 'fixture', CLICKHOUSE_QUERY_PASSWORD: 'fixture' });
  if (!ch) throw new Error('Fixture client');
  const params = { project: 'fixture', from: '2026-11-05T12:00:00.000Z' };
  vi.spyOn(ch, 'query').mockRejectedValue(new Error('unavailable'));
  await expect(read(ch, 'SELECT 1', params)).rejects.toThrow('unavailable');
  expect(params.from).toBe('2026-11-05T12:00:00.000Z');
  await ch.close();
});
it('maps validation wrapper offsets including Unicode', () => {
  const expression = "description = '\u{1f642}' AND";
  const prefix = 'EXPLAIN AST SELECT 1 WHERE (';
  const statement = `${prefix}${expression})`;
  const position = Buffer.byteLength(prefix + expression) + 1;
  expect(sqlSyntaxError(new Error(`Syntax error at position ${position}`), statement, expression).details.start).toBe(expression.length);
});
