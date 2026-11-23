import { describe, expect, it } from 'vitest';
import { compileQuery, QueryError } from './query';
import { re2Problem } from './re2';

describe('RE2 regex validation', () => {
  it.each([
    'booking\\.(created|cancelled)',
    'a\\/b',
    '[a-z0-9_-]+',
    '[^\\]]*',
    '\\d{2,4}\\s\\w+\\b',
    '\\x41\\x{1F600}\\0\\012',
    '\\p{L}+\\pN\\p{Greek}\\p{Thai}',
    '[[:alpha:][:^digit:]]',
    '[\\d-z]',
    '[a-z-\\d]',
    '(?:ab){10}(c{10}){10}',
    '\\Aabc\\z',
    'a{,3}',
  ])('accepts %s', (pattern) => {
    expect(re2Problem(pattern)).toBeNull();
    expect(() => compileQuery(`action:/${pattern}/`)).not.toThrow();
  });

  it.each([
    ['\\cK', 'RE2 does not support the escape \\c'],
    ['\\u0041', 'RE2 does not support the escape \\u'],
    ['(?<name>a)\\k<name>', 'RE2 supports only plain'],
    ['\\Z', 'RE2 does not support the escape \\Z'],
    ['\\e', 'RE2 does not support the escape \\e'],
    ['[\\b]', 'RE2 does not support the escape \\b'],
    ['a[]b', 'Write ] inside a character class'],
    ['[^]', 'Write ] inside a character class'],
    ['[a-\\d]', 'A class shorthand cannot end a range'],
    ['[[:alfa:]]', 'POSIX class'],
    ['\\p{Latn}', 'Unicode general category or script'],
    ['\\p{Nope}', 'Unicode general category or script'],
    ['\\xZ1', 'hex escape'],
    ['(a{100}){11}', 'nested repetitions'],
    ['a{1001}', 'limited to 1000'],
  ])('refuses %s', (pattern, message) => {
    expect(re2Problem(pattern)).toContain(message);
  });

  it('refuses a JavaScript-only escape at compile time with an invalid query error', () => {
    expect(() => compileQuery('action:/\\cK/')).toThrow(QueryError);
    try {
      compileQuery('action:/\\cK/');
    } catch (error) {
      expect((error as QueryError).details).toMatchObject({ reason: 'type', start: 7, end: 12 });
      expect((error as QueryError).message).toBe('RE2 does not support the escape \\c');
    }
  });
});

describe('relative times measured from each arrival', () => {
  const filters = ['occurredAt:[now-5m TO now]', 'timestamp:>now/d', 'attr.due:<now+1d', 'receivedAt:>=now-1h'];

  it.each(filters)('compiles %s independently of the clock', (filter) => {
    const options = { relativeTo: 'received_at' } as const;
    const early = compileQuery(filter, Date.UTC(2026, 0, 1), options);
    const late = compileQuery(filter, Date.UTC(2026, 10, 23, 10), options);
    expect(late).toEqual(early);
    expect(early.sql).toContain('received_at + toIntervalMillisecond(');
    expect(early.sql).not.toContain('parseDateTime64BestEffort({');
  });

  it('keeps the evaluation clock for ordinary searches', () => {
    const early = compileQuery('occurredAt:>now-5m', Date.UTC(2026, 0, 1));
    const late = compileQuery('occurredAt:>now-5m', Date.UTC(2026, 10, 23, 10));
    expect(late.params).not.toEqual(early.params);
    expect(early.sql).not.toContain('received_at +');
  });

  it('binds the offset and rounds now/d on the arrival day', () => {
    const { sql, params } = compileQuery('occurredAt:[now-5m TO now/d]', 0, { relativeTo: 'received_at' });
    expect(sql).toBe(
      "(timestamp >= received_at + toIntervalMillisecond({q0:Int64}) AND timestamp <= toDateTime64(toStartOfDay(received_at + toIntervalMillisecond({q1:Int64}), 'UTC'), 3, 'UTC'))",
    );
    expect(params).toEqual({ q0: -300_000, q1: 0 });
  });
});
