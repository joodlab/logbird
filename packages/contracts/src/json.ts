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

/** Exponents up to this many significant digits use safe-integer arithmetic; longer ones exact string arithmetic. */
const SAFE_EXPONENT_DIGITS = 15;
/**
 * `exponent + shift` for an exponent of any length and a small shift (|shift| < 1e15, from a fraction length).
 * Linear in the exponent's length: only the last 16 digits change, plus a carry or borrow run.
 */
/** Length of the run of `digit` at the end of `text`: one backward scan. */
function trailingRun(text: string, digit: string): number {
  let end = text.length;
  while (end > 0 && text[end - 1] === digit) end--;
  return text.length - end;
}
function shiftExponent(exponent: string, shift: number): string {
  const negative = exponent.startsWith('-');
  const digits = exponent.replace(/^[+-]/, '').replace(/^0+/, '') || '0';
  if (digits.length <= SAFE_EXPONENT_DIGITS) return String((negative ? -1 : 1) * Number(digits) + shift);
  // |exponent| ≥ 1e15 > |shift|, so the sign cannot change: add `delta` to the magnitude.
  const delta = BigInt(negative ? -shift : shift);
  const head = digits.slice(0, -16);
  const tail = BigInt(digits.slice(-16)) + delta;
  const limit = 10n ** 16n;
  let prefix = head;
  let low = tail;
  if (low >= limit) {
    low -= limit;
    const nines = trailingRun(prefix, '9');
    const before = prefix.slice(0, prefix.length - nines);
    prefix = `${before ? `${before.slice(0, -1)}${Number(before.at(-1)) + 1}` : '1'}${'0'.repeat(nines)}`;
  } else if (low < 0n) {
    low += limit;
    const zeros = trailingRun(prefix, '0');
    const before = prefix.slice(0, prefix.length - zeros);
    prefix = `${before.slice(0, -1)}${Number(before.at(-1)) - 1}${'9'.repeat(zeros)}`;
  }
  const magnitude = `${prefix}${low.toString().padStart(16, '0')}`.replace(/^0+/, '') || '0';
  return `${negative ? '-' : ''}${magnitude}`;
}
/**
 * One spelling per decimal value: `-123e-5` for `-0.00123`, `0` for any zero. Null when `text` is not a JSON/JS
 * number spelling (e.g. Infinity). Exponents of any length are exact (string arithmetic); a number whose exponent overflows or underflows a
 * double and keeps its sent spelling). Linear in the input: digit scans and safe-integer arithmetic only.
 */
export function canonicalDecimal(text: string): string | null {
  const m = NUMBER.exec(text);
  if (!m) return null;
  const fraction = m[3] ?? '';
  const all = `${m[2]}${fraction}`;
  let start = 0;
  while (start < all.length && all.charCodeAt(start) === 48) start++;
  // Zero is zero whatever its exponent; padded exponents (`1e0000000000000000`) are measured without their zeros.
  if (start === all.length) return '0';
  let end = all.length;
  while (all.charCodeAt(end - 1) === 48) end--;
  return `${m[1]}${all.slice(start, end)}e${shiftExponent(m[4] ?? '0', all.length - end - fraction.length)}`;
}

/** True when the double `value` denotes exactly the decimal written as `source` (`19.90` → 19.9 and `1e3` → 1000 do). */
export function isExactNumber(source: string, value: number) {
  return Number.isFinite(value) && canonicalDecimal(source) === canonicalDecimal(String(value));
}

/**
 * Plain decimal text of a number's exact value, one spelling per value: `42`, `42.0` and `4.2e1` give `42`;
 * `-0.00123` gives `-0.00123`. Null when not a finite number, when the plain form would exceed `maxLength`, or when
 * it would add more than `maxPadding` zeros to the significant digits (the decimal point is not counted): `1e+2047` is 7
 * characters but 2,048 plain. The bound depends on the value, never on how it was spelled.
 */
export function plainDecimal(value: unknown, maxLength = 1024, maxPadding = Number.POSITIVE_INFINITY): string | null {
  const source = isRawJson(value) ? value.rawJSON : typeof value === 'number' && Number.isFinite(value) ? String(value) : null;
  const canonical = source === null ? null : canonicalDecimal(source);
  if (canonical === null) return null;
  if (canonical === '0') return '0';
  const e = canonical.indexOf('e');
  const sign = canonical.startsWith('-') ? '-' : '';
  const digits = canonical.slice(sign.length, e);
  const exp = Number(canonical.slice(e + 1));
  const point = digits.length + exp;
  // Exact output length, checked before any padding is allocated.
  const length = sign.length + (exp >= 0 ? digits.length + exp : point > 0 ? digits.length + 1 : 2 - point + digits.length);
  // Zeros added around the significant digits: the length without the sign, the digits and (for exp < 0) the point.
  if (length > maxLength || length - sign.length - digits.length - (exp < 0 ? 1 : 0) > maxPadding) return null;
  if (exp >= 0) return `${sign}${digits}${'0'.repeat(exp)}`;
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

/**
 * A double holds every decimal with at most 15 significant digits exactly, so an inexact number needs 16+ digits
 * (one dot allowed in the run) or a 3+ digit exponent. Texts without such a run skip the reviver (plain JSON.parse
 * speed); digits inside strings only cause a harmless slow path.
 */
const MAYBE_INEXACT = /\d[\d.]{15}|[eE][+-]?\d{3}/;

export function parseJsonExact(text: string): unknown {
  if (!supportsExactJson || !MAYBE_INEXACT.test(text)) return JSON.parse(text);
  const raw = json.rawJSON as (text: string) => RawJson;
  try {
    return JSON.parse(text, function reviver(this: unknown, _key: string, value: unknown, context?: { source?: string }) {
      if (typeof value !== 'number' || typeof context?.source !== 'string' || isExactNumber(context.source, value)) return value;
      return raw(context.source);
    } as (this: unknown, key: string, value: unknown) => unknown);
  } catch (error) {
    // The reviver recurses; a document nested past its stack depth (thousands of levels) is parsed iteratively, with
    // the same values and exact numbers, instead of being refused or rounded.
    if (error instanceof RangeError) return parseJsonExactIterative(text);
    throw error;
  }
}

// Control characters are exactly what JSON forbids unescaped inside strings.
// biome-ignore lint/suspicious/noControlCharactersInRegex: JSON string grammar excludes U+0000–U+001F
const STRING_TOKEN = /"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/y;
const NUMBER_TOKEN = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
type Frame = { container: unknown[] | Record<string, unknown>; key: string };

/**
 * JSON.parse semantics without recursion (explicit stack), keeping numbers a double cannot hold as raw JSON values.
 * Duplicate keys keep the first position with the last value, and `__proto__` is an own data property, as in
 * JSON.parse. Only used when the reviver overflows, and where exact JSON is supported.
 */
export function parseJsonExactIterative(text: string): unknown {
  const raw = json.rawJSON as (text: string) => RawJson;
  const n = text.length;
  let i = 0;
  const fail = (): never => {
    throw new SyntaxError(`Unexpected token in JSON at position ${i}`);
  };
  const ws = () => {
    for (let c = text.charCodeAt(i); c === 32 || c === 9 || c === 10 || c === 13; c = text.charCodeAt(++i));
  };
  const readString = (): string => {
    STRING_TOKEN.lastIndex = i;
    const m = STRING_TOKEN.exec(text);
    if (!m) return fail();
    i = STRING_TOKEN.lastIndex;
    return JSON.parse(m[0]) as string;
  };
  const stack: Frame[] = [];
  let root: unknown;
  const put = (value: unknown) => {
    const top = stack.at(-1);
    if (!top) root = value;
    else if (Array.isArray(top.container)) top.container.push(value);
    else Object.defineProperty(top.container, top.key, { value, writable: true, enumerable: true, configurable: true });
  };
  const readKey = (frame: Frame) => {
    ws();
    if (text[i] !== '"') fail();
    frame.key = readString();
    ws();
    if (text[i] !== ':') fail();
    i++;
  };
  let expectValue = true;
  for (;;) {
    ws();
    if (expectValue) {
      const c = text[i];
      if (c === '{' || c === '[') {
        i++;
        const container: unknown[] | Record<string, unknown> = c === '[' ? [] : {};
        put(container);
        const frame: Frame = { container, key: '' };
        stack.push(frame);
        ws();
        if (text[i] === (c === '[' ? ']' : '}')) {
          i++;
          stack.pop();
          expectValue = false;
        } else if (c === '{') readKey(frame);
        continue;
      }
      expectValue = false;
      if (c === '"') put(readString());
      else if (text.startsWith('true', i)) {
        put(true);
        i += 4;
      } else if (text.startsWith('false', i)) {
        put(false);
        i += 5;
      } else if (text.startsWith('null', i)) {
        put(null);
        i += 4;
      } else {
        NUMBER_TOKEN.lastIndex = i;
        const m = NUMBER_TOKEN.exec(text);
        if (!m) fail();
        const token = (m as RegExpExecArray)[0];
        i = NUMBER_TOKEN.lastIndex;
        const value = Number(token);
        put(isExactNumber(token, value) ? value : raw(token));
      }
      continue;
    }
    const top = stack.at(-1);
    if (!top) {
      if (i !== n) fail();
      return root;
    }
    const c = text[i];
    if (c === ',') {
      i++;
      if (!Array.isArray(top.container)) readKey(top);
      expectValue = true;
    } else if (c === (Array.isArray(top.container) ? ']' : '}')) {
      i++;
      stack.pop();
    } else fail();
  }
}

/** Nesting depth up to which raw numbers are kept: deeper, JSON.stringify with raw values overflows the stack. */
export const EXACT_NUMBER_MAX_DEPTH = 1000;
/**
 * True when `value` nests deeper than EXACT_NUMBER_MAX_DEPTH and holds a raw JSON number (one a double cannot keep).
 * Such an event is rejected rather than rounded: rounding would let a changed digit match as an exact retry.
 * Iterative and read-only, so depth itself never overflows.
 */
export function hasDeepRawNumbers(value: unknown, maxDepth = EXACT_NUMBER_MAX_DEPTH): boolean {
  let deep = false;
  let raw = false;
  // Visited set: caller-owned graphs may contain cycles (they then fail serialization as before).
  const seen = new WeakSet<object>();
  const stack: [unknown, number][] = [[value, 1]];
  while (stack.length && !(deep && raw)) {
    const [node, depth] = stack.pop() as [unknown, number];
    if (isRawJson(node)) raw = true;
    else if (node !== null && typeof node === 'object' && !seen.has(node)) {
      seen.add(node);
      if (depth > maxDepth) deep = true;
      // Only containers and raw numbers are pending work; ordinary primitive leaves are skipped.
      for (const child of Object.values(node)) if (child !== null && typeof child === 'object') stack.push([child, depth + 1]);
    }
  }
  return deep && raw;
}
