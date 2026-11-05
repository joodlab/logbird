import { describe, expect, it } from 'vitest';
import { queryHint, sqlHint } from './hints';
import { ageLabel, groupStable, matchScore, type Suggestion } from './use-completions';

describe('matchScore', () => {
  it('ranks prefix, word-segment, substring, fuzzy and description matches', () => {
    expect(matchScore('ten', 'tenant.name')).toBe(0);
    expect(matchScore('name', 'tenant.name')).toBe(1);
    expect(matchScore('nan', 'tenant.name')).toBe(2);
    expect(matchScore('tnm', 'tenant.name')).toBe(3);
    expect(matchScore('acn', 'actor.name')).toBe(3);
    expect(matchScore('customer', 'tenant', 'Customer account (tenant id)')).toBe(4);
    expect(matchScore('zz', 'tenant')).toBe(-1);
    // Fuzzy matches start at a word boundary, so random letters don't match.
    expect(matchScore('nt', 'tenant')).toBe(2);
    expect(matchScore('ea', 'tenant')).toBe(-1);
  });
});

describe('groupStable', () => {
  it('keeps groups contiguous in order of first appearance', () => {
    const s = (id: string, group: string) => ({ id, group }) as Suggestion;
    expect(groupStable([s('a', 'Columns'), s('b', 'Functions'), s('c', 'Columns')]).map((x) => x.id)).toEqual(['a', 'c', 'b']);
  });
});

describe('ageLabel', () => {
  it('formats compact ages', () => {
    const now = 1_000_000_000;
    expect(ageLabel(now - 10_000, now)).toBe('now');
    expect(ageLabel(now - 5 * 60_000, now)).toBe('5m');
    expect(ageLabel(now - 3 * 3_600_000, now)).toBe('3h');
    expect(ageLabel(now - 2 * 86_400_000, now)).toBe('2d');
  });
});

describe('hint row', () => {
  const text = (h: ReturnType<typeof queryHint>) => [h.label, ...h.parts.map((p) => (typeof p === 'string' ? p : p.code))].join('');

  it('describes what the current token expects', () => {
    expect(
      text(queryHint({ kind: 'value', field: 'attempt', prefix: '', from: 8, to: 8, inGroup: false, quoted: false }, 'attempt:', 8, [])),
    ).toContain('attempt:[2 TO 5]');
    expect(
      queryHint({ kind: 'value', field: 'occurredAt', prefix: '', from: 11, to: 11, inGroup: false, quoted: false }, 'occurredAt:', 11, []).label,
    ).toBe('occurredAt · date (UTC)');
    expect(queryHint({ kind: 'key', prefix: '', from: 16, to: 16, afterTerm: true }, 'outcome:failure ', 16, []).label).toBe('Next term');
    expect(text(queryHint({ kind: 'range', field: 'attempt' }, 'attempt:[1', 10, []))).toContain('{a TO b}');
  });

  it('puts a conversion first when the caret is on one', () => {
    const h = queryHint({ kind: 'key', prefix: '', from: 0, to: 0, afterTerm: false }, 'tenant = x', 10, [
      { start: 0, end: 10, replacement: 'tenant:x', message: 'KQL' },
    ]);
    expect(h.tone).toBe('warn');
    expect(text(h)).toContain('tenant:x');
  });

  it('shows SQL signatures with the current argument emphasised', () => {
    const h = sqlHint(
      { kind: 'value', field: 'target.type', column: 'target_types', prefix: '', from: 18, to: 18, closeQuote: true },
      'has(target_types, ',
      {
        name: 'has',
        arg: 1,
      },
    );
    expect(h.parts[0]).toEqual({ code: 'has(array, value)', em: [11, 16] });
  });
});
