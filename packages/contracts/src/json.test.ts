import { expect, it } from 'vitest';
import { canonicalDecimal, isExactNumber, isRawJson, parseJsonExact, plainDecimal, rawJsonText, supportsExactJson } from './json';

it('runs on a runtime with JSON.parse source text access', () => {
  expect(supportsExactJson).toBe(true);
});

it.each([
  ['9007199254740993', '9007199254740993'],
  ['1234567890123456789', '1234567890123456789'],
  ['-12345678901234567891', '-12345678901234567891'],
  ['0.12345678901234567890123', '0.12345678901234567890123'],
  ['1e400', '1e400'],
  ['123456789012345678901234567890e-5', '123456789012345678901234567890e-5'],
])('keeps the exact digits of %s', (source, expected) => {
  const parsed = parseJsonExact(`{"n":${source},"list":[${source}]}`) as { n: unknown; list: unknown[] };
  expect(isRawJson(parsed.n)).toBe(true);
  expect(rawJsonText(parsed.n)).toBe(expected);
  expect(JSON.stringify(parsed)).toBe(`{"n":${expected},"list":[${expected}]}`);
});

it.each([
  ['0', 0],
  ['-0', -0],
  ['42', 42],
  ['9007199254740991', 9_007_199_254_740_991],
  ['0.1', 0.1],
  ['19.90', 19.9],
  ['1e3', 1000],
  ['1E+3', 1000],
  ['2.5e-7', 2.5e-7],
  ['1795325485138', 1_795_325_485_138],
  ['1e21', 1e21],
])('keeps %s a plain number because a double holds it exactly', (source, value) => {
  const parsed = parseJsonExact(`[${source}]`) as unknown[];
  expect(isRawJson(parsed[0])).toBe(false);
  expect(Object.is(parsed[0], value)).toBe(true);
});

it('matches JSON.parse for documents without inexact numbers', () => {
  const text = '{"a":[1,2.5,{"b":null,"c":true,"d":"x\\u0000y"}],"e":-3e2,"f":"😀"}';
  expect(parseJsonExact(text)).toEqual(JSON.parse(text));
  expect(JSON.stringify(parseJsonExact(text))).toBe(JSON.stringify(JSON.parse(text)));
});

it('compares decimals by value, not spelling', () => {
  expect(isExactNumber('100', 100)).toBe(true);
  expect(isExactNumber('1.000e2', 100)).toBe(true);
  expect(isExactNumber('0.30000000000000004', 0.1 + 0.2)).toBe(true);
  expect(isExactNumber('0.3000000000000000444', 0.1 + 0.2)).toBe(false);
  expect(isExactNumber('1e400', Number.POSITIVE_INFINITY)).toBe(false);
});

it('reads plain numbers and rejects other values in rawJsonText', () => {
  expect(rawJsonText(12)).toBe('12');
  expect(rawJsonText(Number.NaN)).toBeNull();
  expect(rawJsonText('12')).toBeNull();
  expect(rawJsonText({ rawJSON: '12' })).toBeNull();
});

it('gives one canonical spelling per value, with exact exponents', () => {
  for (const s of ['9007199254740993', '9007199254740993.0', '9.007199254740993e15', '900719925474099300e-2', '0009007199254740993'])
    expect(canonicalDecimal(s)).toBe('9007199254740993e0');
  expect(canonicalDecimal('-0.00123')).toBe('-123e-5');
  expect(canonicalDecimal('0.000')).toBe('0');
  expect(canonicalDecimal('1e99999999999999999999')).toBeNull();
  expect(canonicalDecimal('Infinity')).toBeNull();
});

it('canonicalizes a hostile number token in linear time', () => {
  const token = `1${'0'.repeat(4_000_000)}1`;
  const start = Date.now();
  expect(canonicalDecimal(token)).toBe(`${token}e0`);
  expect(isRawJson((parseJsonExact(`[${token}]`) as unknown[])[0])).toBe(true);
  expect(Date.now() - start).toBeLessThan(1000);
});

it.each([
  ['42', '42'],
  ['42.0', '42'],
  ['4.2e1', '42'],
  ['-0.00123', '-0.00123'],
  ['1.5e-3', '0.0015'],
  ['9007199254740993.0', '9007199254740993'],
  ['12345678901234567891', '12345678901234567891'],
  ['0.12345678901234567890123', '0.12345678901234567890123'],
  ['-0', '0'],
])('writes %s as the plain decimal %s', (source, expected) => {
  expect(plainDecimal((parseJsonExact(`[${source}]`) as unknown[])[0])).toBe(expected);
});

it('refuses plain decimals that would be huge, and non-numbers', () => {
  expect(plainDecimal((parseJsonExact('[1e2000]') as unknown[])[0])).toBeNull();
  expect(plainDecimal((parseJsonExact('[1e400]') as unknown[])[0])).toHaveLength(401);
  expect(plainDecimal('42')).toBeNull();
  expect(plainDecimal(true)).toBeNull();
});

it('skips arithmetic for exponents over 15 significant digits, in linear time', () => {
  const huge = `1e-${'9'.repeat(1_000_000)}`;
  const padded = `1e-${'0'.repeat(1_000_000)}5`;
  const start = Date.now();
  expect(canonicalDecimal(huge)).toBeNull();
  expect(isRawJson((parseJsonExact(`[${huge}]`) as unknown[])[0])).toBe(true);
  // Exponent padding is not significant: this is 0.00001, a plain number.
  expect(canonicalDecimal(padded)).toBe('1e-5');
  expect((parseJsonExact(`[${padded}]`) as unknown[])[0]).toBe(0.000_01);
  expect(Date.now() - start).toBeLessThan(1000);
  expect((parseJsonExact('[1e0000000000000000]') as unknown[])[0]).toBe(1);
  expect((parseJsonExact('[0e99999999999999999999]') as unknown[])[0]).toBe(0);
  expect(canonicalDecimal('1e123456789012345')).toBe('1e123456789012345');
});

it('measures plain decimal length exactly', () => {
  expect(plainDecimal(1.23, 4)).toBe('1.23');
  expect(plainDecimal(1.23, 3)).toBeNull();
  expect(plainDecimal(0.001, 5)).toBe('0.001');
  expect(plainDecimal(-1200, 5)).toBe('-1200');
});

it('lets the input contract accept the exact ids the parser produces', async () => {
  const { eventInputSchema } = await import('./events');
  const event = parseJsonExact(
    '{"action":"x","actor":{"id":9007199254740993},"tenant":{"id":7},"targets":[{"type":"page","id":12345678901234567891}]}',
  );
  expect(eventInputSchema.safeParse(event).success).toBe(true);
  expect(eventInputSchema.safeParse({ action: 'x', actor: { id: true } }).success).toBe(false);
});
