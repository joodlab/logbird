/**
 * Exact JSON numbers, copied from @logbird/contracts (the published SDK has no runtime dependencies).
 *
 * A value built with `JSON.rawJSON('1234567890123456789')` serializes with its exact digits. Plain `JSON.parse`
 * would round it to a double when the SDK copies an event, so copies go through `parseJsonExact`, which keeps every
 * number a double cannot hold as a raw JSON number. Falls back to `JSON.parse` where unsupported.
 */
type RawJson = { readonly rawJSON: string };
type ExactJson = JSON & { rawJSON?: (text: string) => RawJson; isRawJSON?: (value: unknown) => boolean };
const json = JSON as ExactJson;
const NUMBER = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/;

function canonicalDecimal(text: string): string | null {
  const m = NUMBER.exec(text);
  if (!m) return null;
  const fraction = m[3] ?? '';
  const all = `${m[2]}${fraction}`;
  let start = 0;
  while (start < all.length && all.charCodeAt(start) === 48) start++;
  if (start === all.length) return '0';
  // Same bounds as @logbird/contracts: safe-integer exponents, bounded BigInt up to 1000 digits, else the spelling.
  const expDigits = (m[4] ?? '').replace(/^[+-]/, '').replace(/^0+/, '').length;
  if (expDigits > 1000) return null;
  let end = all.length;
  while (all.charCodeAt(end - 1) === 48) end--;
  const shift = all.length - end - fraction.length;
  const exponent = expDigits > 15 ? (BigInt(m[4] ?? 0) + BigInt(shift)).toString() : String(Number(m[4] ?? 0) + shift);
  return `${m[1]}${all.slice(start, end)}e${exponent}`;
}

export const isRawJson = (value: unknown): value is RawJson => typeof json.isRawJSON === 'function' && json.isRawJSON(value) === true;

// Only 16+ digit runs or 3+ digit exponents can be inexact; other texts take plain JSON.parse.
const MAYBE_INEXACT = /\d[\d.]{15}|[eE][+-]?\d{3}/;

export function parseJsonExact(text: string): unknown {
  const raw = json.rawJSON;
  if (typeof raw !== 'function' || typeof json.isRawJSON !== 'function' || !MAYBE_INEXACT.test(text)) return JSON.parse(text);
  try {
    return JSON.parse(text, function reviver(this: unknown, _key: string, value: unknown, context?: { source?: string }) {
      if (typeof value !== 'number' || typeof context?.source !== 'string') return value;
      if (Number.isFinite(value) && canonicalDecimal(context.source) === canonicalDecimal(String(value))) return value;
      return raw(context.source);
    } as (this: unknown, key: string, value: unknown) => unknown);
  } catch (error) {
    // Documents nested past the reviver's stack depth parse like plain JSON.parse instead of failing.
    if (error instanceof RangeError) return JSON.parse(text);
    throw error;
  }
}
