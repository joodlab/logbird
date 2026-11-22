/**
 * Exact JSON numbers.
 *
 * `JSON.parse` turns every number into a double, so 64-bit ids (`1234567890123456789`) and long decimals lose digits.
 * `parseJsonExact` keeps such a number as a raw JSON value (`JSON.rawJSON`): `JSON.stringify` writes its original
 * digits back unchanged, `rawJsonText` reads them. Numbers that a double represents exactly (the usual case) stay
 * plain numbers, so values, identity and serialization of ordinary events are unchanged.
 *
 * Needs JSON.parse source text access (Node 21+, current browsers). Where it is missing, parsing falls back to
 * plain `JSON.parse`.
 */
export type RawJson = { readonly rawJSON: string };
type ExactJson = JSON & { rawJSON?: (text: string) => RawJson; isRawJSON?: (value: unknown) => boolean };
const json = JSON as ExactJson;
const NUMBER = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/;

/**
 * One spelling per decimal value: `-123e-5` for `-0.00123`, `0` for any zero; null when `text` is not a finite JSON/JS
 * number spelling (e.g. Infinity). Linear in the input: digit scans, no backtracking patterns.
 */
export function canonicalDecimal(text: string): string | null {
  const m = NUMBER.exec(text);
  if (!m) return null;
  const fraction = m[3] ?? '';
  const all = `${m[2]}${fraction}`;
  let start = 0;
  while (start < all.length && all.charCodeAt(start) === 48) start++;
  if (start === all.length) return '0';
  let end = all.length;
  while (all.charCodeAt(end - 1) === 48) end--;
  const exponent = BigInt(m[4] ?? 0) - BigInt(fraction.length) + BigInt(all.length - end);
  return `${m[1]}${all.slice(start, end)}e${exponent}`;
}

/** True when the double `value` denotes exactly the decimal written as `source` (`19.90` → 19.9 and `1e3` → 1000 do). */
export function isExactNumber(source: string, value: number) {
  return Number.isFinite(value) && canonicalDecimal(source) === canonicalDecimal(String(value));
}

/**
 * Plain decimal text of a number's exact value, one spelling per value: `42`, `42.0` and `4.2e1` give `42`;
 * `-0.00123` gives `-0.00123`. Null when not a finite number or when the plain form would exceed `maxLength`.
 */
export function plainDecimal(value: unknown, maxLength = 1024): string | null {
  const source = isRawJson(value) ? value.rawJSON : typeof value === 'number' && Number.isFinite(value) ? String(value) : null;
  const canonical = source === null ? null : canonicalDecimal(source);
  if (canonical === null) return null;
  if (canonical === '0') return '0';
  const e = canonical.indexOf('e');
  const sign = canonical.startsWith('-') ? '-' : '';
  const digits = canonical.slice(sign.length, e);
  const exponent = BigInt(canonical.slice(e + 1));
  const length = BigInt(sign.length + digits.length) + (exponent >= 0n ? exponent : -exponent + 1n);
  if (length > BigInt(maxLength)) return null;
  const exp = Number(exponent);
  if (exp >= 0) return `${sign}${digits}${'0'.repeat(exp)}`;
  const point = digits.length + exp;
  return point > 0 ? `${sign}${digits.slice(0, point)}.${digits.slice(point)}` : `${sign}0.${'0'.repeat(-point)}${digits}`;
}

export const isRawJson = (value: unknown): value is RawJson => typeof json.isRawJSON === 'function' && json.isRawJSON(value) === true;

/** Exact decimal text of a number or raw JSON number; null for anything else. */
export function rawJsonText(value: unknown): string | null {
  if (isRawJson(value)) return value.rawJSON;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

export const supportsExactJson = typeof json.rawJSON === 'function' && typeof json.isRawJSON === 'function';

/** A raw JSON number from exact decimal text (`JSON.rawJSON`); only valid where `supportsExactJson`. */
export function rawJsonNumber(text: string): RawJson {
  if (!json.rawJSON) throw new Error('JSON.rawJSON is not supported by this runtime');
  return json.rawJSON(text);
}

export function parseJsonExact(text: string): unknown {
  if (!supportsExactJson) return JSON.parse(text);
  const raw = json.rawJSON as (text: string) => RawJson;
  return JSON.parse(text, function reviver(this: unknown, _key: string, value: unknown, context?: { source?: string }) {
    if (typeof value !== 'number' || typeof context?.source !== 'string' || isExactNumber(context.source, value)) return value;
    return raw(context.source);
  } as (this: unknown, key: string, value: unknown) => unknown);
}
