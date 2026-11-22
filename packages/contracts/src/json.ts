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

/** Sign, significant digits and exponent of a JSON/JS number spelling, or null when it is not one (e.g. Infinity). */
function canonicalDecimal(text: string): string | null {
  const m = NUMBER.exec(text);
  if (!m) return null;
  const fraction = m[3] ?? '';
  let digits = `${m[2]}${fraction}`.replace(/^0+/, '');
  if (!digits) return '0';
  let exponent = Number(m[4] ?? 0) - fraction.length;
  const trailing = /0+$/.exec(digits)?.[0].length ?? 0;
  digits = digits.slice(0, digits.length - trailing);
  exponent += trailing;
  return `${m[1]}${digits}e${exponent}`;
}

/** True when the double `value` denotes exactly the decimal written as `source` (`19.90` → 19.9 and `1e3` → 1000 do). */
export function isExactNumber(source: string, value: number) {
  return Number.isFinite(value) && canonicalDecimal(source) === canonicalDecimal(String(value));
}

export const isRawJson = (value: unknown): value is RawJson => typeof json.isRawJSON === 'function' && json.isRawJSON(value) === true;

/** Exact decimal text of a number or raw JSON number; null for anything else. */
export function rawJsonText(value: unknown): string | null {
  if (isRawJson(value)) return value.rawJSON;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

export const supportsExactJson = typeof json.rawJSON === 'function' && typeof json.isRawJSON === 'function';

export function parseJsonExact(text: string): unknown {
  if (!supportsExactJson) return JSON.parse(text);
  const raw = json.rawJSON as (text: string) => RawJson;
  return JSON.parse(text, function reviver(this: unknown, _key: string, value: unknown, context?: { source?: string }) {
    if (typeof value !== 'number' || typeof context?.source !== 'string' || isExactNumber(context.source, value)) return value;
    return raw(context.source);
  } as (this: unknown, key: string, value: unknown) => unknown);
}
