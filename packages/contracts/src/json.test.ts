import { expect, it } from 'vitest';
import { isExactNumber, isRawJson, parseJsonExact, rawJsonText, supportsExactJson } from './json';

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
