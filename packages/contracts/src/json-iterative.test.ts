import { expect, it } from 'vitest';
import { eventInputSchema } from './events';
import { parseJsonExact, parseJsonExactIterative, rawJsonText } from './json';

function rng(start = 42) {
  let seed = start;
  return () => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return seed / 2_147_483_648;
  };
}
const leafOf = (value: unknown) => {
  let node = value;
  while (Array.isArray(node)) node = node[0];
  return node;
};

const leaves: unknown[] = [null, true, false, 0, -1.5, 1e-7, 123_456, 'x', '\u0000"\\/ 😀', '', 'لينا'];
const keys = ['a', '__proto__', 'b c', '0', 'ü'];

it('parses iteratively with exactly JSON.parse semantics', () => {
  const next = rng();
  const value = (depth: number): unknown => {
    const r = next();
    if (depth > 4 || r < 0.3) return leaves[Math.floor(next() * leaves.length)];
    if (r < 0.65) return Array.from({ length: Math.floor(next() * 4) }, () => value(depth + 1));
    return Object.fromEntries(Array.from({ length: Math.floor(next() * 4) }, (_, k) => [keys[k % keys.length] as string, value(depth + 1)]));
  };
  for (let k = 0; k < 300; k++) {
    const text = JSON.stringify(value(0), null, k % 2 ? 2 : undefined);
    expect(parseJsonExactIterative(text)).toEqual(JSON.parse(text));
  }
});

it('keeps duplicate keys and __proto__ like JSON.parse, and rejects invalid JSON', () => {
  const dup = parseJsonExactIterative('{"a":1,"b":2,"a":3}') as Record<string, number>;
  expect(Object.keys(dup)).toEqual(['a', 'b']);
  expect(dup.a).toBe(3);
  expect(Object.hasOwn(parseJsonExactIterative('{"__proto__":{"x":1}}') as object, '__proto__')).toBe(true);
  const invalid = ['', '[1,]', '{"a":1,}', '01', '[1 2]', '"\\x"', '{"a"}', 'tru', '[', '1 2', '"a\nb"', '-', '1.', '.5', '+1'];
  for (const bad of invalid) {
    expect(() => JSON.parse(bad)).toThrow(SyntaxError);
    expect(() => parseJsonExactIterative(bad)).toThrow(SyntaxError);
  }
});

it('keeps exact digits iteratively, also deep and beside a deep wrapper property', () => {
  expect(JSON.stringify(parseJsonExactIterative('[12345678901234567891, 0.1, 19.90]'))).toBe('[12345678901234567891,0.1,19.9]');
  const deep = `${'['.repeat(5000)}12345678901234567891${']'.repeat(5000)}`;
  // Walk down instead of stringifying: JSON.stringify itself overflows on raw values this deep.
  expect(rawJsonText(leafOf(parseJsonExact(deep)))).toBe('12345678901234567891');
  const body = `{"events":[{"action":"x","metadata":{"snowflake":9007199254740993}}],"ignored":${'['.repeat(20_000)}1${']'.repeat(20_000)}}`;
  const parsed = parseJsonExact(body) as { events: { metadata: unknown }[] };
  expect(JSON.stringify(parsed.events[0]?.metadata)).toBe('{"snowflake":9007199254740993}');
});

it('accepts an exact epoch-millisecond occurredAt in the input contract', () => {
  expect(eventInputSchema.safeParse(parseJsonExact('{"action":"x","occurredAt":1795325485138.12345678901234}')).success).toBe(true);
});
