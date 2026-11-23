import { describe, expect, it } from 'vitest';
import { compileQuery, QueryError, WEBHOOK_FILTER, WEBHOOK_RELATIVE_LIMIT_MS } from './query';
import { re2Problem } from './re2';

describe('RE2 regex validation for webhook filters', () => {
  it.each([
    'booking\\.(created|cancelled)',
    'a\\/b',
    '[a-z0-9_-]+',
    '[^\\]]*',
    '[]a]',
    '\\d{2,4}\\s\\w+\\b',
    '\\x41\\x{1F600}\\0\\012',
    '\\a\\f\\t\\n\\r\\v\\C',
    '\\p{L}+\\pN\\p{Greek}\\p{^Greek}\\PL',
    '[[:alpha:][:^digit:]]',
    '[\\d-z]',
    '[a-z-\\d]',
    '(?:ab){10}(c{10}){10}',
    '\\Aabc\\z',
    'a{,3}',
    '\\Qbooking.created\\E',
    '\\Q(a+)[b]{2}\\Ex',
    '\\Qno end',
    '(?i)booking',
    '(?i:Booking)\\.(?s:.)',
    '(?P<kind>booking)\\.(?<verb>created)',
    '(?P<1>a)',
    'a*?b+?c??d{2}?',
  ])('accepts %s', (pattern) => {
    expect(re2Problem(pattern)).toBeNull();
    expect(() => compileQuery(`action:/${pattern}/`, Date.now(), WEBHOOK_FILTER)).not.toThrow();
  });

  it.each([
    ['\\cK', 'RE2 does not support the escape \\c'],
    ['\\u0041', 'RE2 does not support the escape \\u'],
    ['(?<name>a)\\k<name>', 'RE2 does not support the escape \\k'],
    ['\\Z', 'RE2 does not support the escape \\Z'],
    ['\\e', 'RE2 does not support the escape \\e'],
    ['(a)\\1', 'backreferences'],
    ['\\8', 'backreferences'],
    ['a(?=b)', 'lookaround'],
    ['(?<!a)b', 'lookaround'],
    ['(?>a)', 'lookaround'],
    ['[a-\\d]', 'A class shorthand cannot end a range'],
    ['[[:alfa:]]', 'POSIX class'],
    ['\\xZ1', 'hex escape'],
    ['(a{100}){11}', 'nested repetitions'],
    ['a{1001}', 'limited to 1000'],
    ['a{3,2}', 'backwards'],
    ['a**', 'repeating a repetition'],
    ['a*+', 'repeating a repetition'],
    ['*a', 'something to repeat'],
    ['(a', 'Unbalanced'],
    ['a)', 'Unbalanced'],
    ['[a', 'Close the character class'],
    ['a\\', 'cannot end with a backslash'],
  ])('refuses %s', (pattern, message) => {
    expect(re2Problem(pattern)).toContain(message);
  });

  it('refuses a JavaScript-only escape in a webhook filter with an invalid query error', () => {
    expect(() => compileQuery('action:/\\cK/', Date.now(), WEBHOOK_FILTER)).toThrow(QueryError);
    try {
      compileQuery('action:/\\cK/', Date.now(), WEBHOOK_FILTER);
    } catch (error) {
      expect((error as QueryError).details).toMatchObject({ reason: 'type', start: 7, end: 12 });
      expect((error as QueryError).message).toBe('RE2 does not support the escape \\c');
    }
  });
});

describe('Explorer, search and export filters keep their regex behaviour', () => {
  // The same compiled SQL and parameters as before webhook filters had their own check.
  it.each([
    ['action:/\\Qbooking.created\\E/', '^(?:\\Qbooking.created\\E)$'],
    ['action:/booking\\.(created|cancelled)/', '^(?:booking\\.(created|cancelled))$'],
    ['action:/\\p{Lu}.*/', '^(?:\\p{Lu}.*)$'],
  ])('compiles %s unchanged', (query, pattern) => {
    expect(compileQuery(query)).toEqual({ sql: '(match(action, {q0:String}))', params: { q0: pattern } });
  });

  it('still refuses what it refused before, with the same message', () => {
    for (const query of ['action:/a(?=b)/', 'action:/(a)\\1/', 'action:/a{1001}/', 'action:/(/'])
      expect(() => compileQuery(query)).toThrow('Use a valid RE2 regex without lookaround or backreferences');
  });
});

describe('relative times in webhook filters', () => {
  const filters = ['occurredAt:[now-5m TO now]', 'timestamp:>now/d', 'attr.due:<now+1d', 'receivedAt:>=now-1h'];

  it.each(filters)('compiles %s independently of the clock', (filter) => {
    const early = compileQuery(filter, Date.UTC(2026, 0, 1), WEBHOOK_FILTER);
    const late = compileQuery(filter, Date.UTC(2026, 10, 23, 10), WEBHOOK_FILTER);
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
    const { sql, params } = compileQuery('occurredAt:[now-5m TO now/d]', 0, WEBHOOK_FILTER);
    expect(sql).toBe(
      "(timestamp >= received_at + toIntervalMillisecond({q0:Int64}) AND timestamp <= toDateTime64(toStartOfDay(received_at + toIntervalMillisecond({q1:Int64}), 'UTC'), 3, 'UTC'))",
    );
    expect(params).toEqual({ q0: -300_000, q1: 0 });
  });

  it('accepts offsets up to the fixed limit and refuses one day more, whatever the clock', () => {
    const days = WEBHOOK_RELATIVE_LIMIT_MS / 86_400_000;
    for (const clock of [0, Date.UTC(2026, 10, 23), Date.UTC(2099, 0, 1), 8.64e15]) {
      for (const sign of ['-', '+']) {
        expect(() => compileQuery(`occurredAt:>now${sign}${days}d`, clock, WEBHOOK_FILTER)).not.toThrow();
        expect(() => compileQuery(`occurredAt:>now${sign}${days + 1}d`, clock, WEBHOOK_FILTER)).toThrow('Relative date is out of range');
      }
    }
  });
});
