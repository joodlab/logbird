/** Value after outer query quotes have been removed. Use this as the saved label key. */
export function encodeRecordPair(type: string, id: string): string {
  return `${type.replace(/[:\\]/g, '\\$&')}:${id}`;
}

export function decodeRecordPair(value: string): { type: string; id: string } | null {
  let type = '';
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === ':') return { type, id: value.slice(i + 1) };
    const next = value[i + 1];
    if (ch === '\\' && (next === ':' || next === '\\')) {
      type += next;
      i++;
    } else type += ch;
  }
  return null;
}

const BARE_RECORD_VALUE = /^[^\s()"<>[\]{}]+/;

/** Slashes and stars inside a bare record pair are literal. */
export function scanBareRecordValue(input: string, start: number): number {
  const bare = BARE_RECORD_VALUE.exec(input.slice(start))?.[0] ?? '';
  const operator = /&&|\|\|/.exec(bare);
  return start + (operator?.index ?? bare.length);
}

/** Decode the outer value syntax, keeping a wildcard distinct from a literal star. */
export function readQueryValue(raw: string): { value: string; wildcard: boolean } {
  const quoted = raw.startsWith('"');
  const body = quoted ? raw.slice(1, raw.endsWith('"') && raw.length > 1 ? -1 : undefined) : raw;
  const wildcard = body.endsWith('*') && /(?:^|[^\\])(?:\\\\)*\*$/.test(body);
  const value = quoted
    ? body.replace(/\\([\s\S])/g, (_, escaped: string) => (escaped === 'r' ? '\r' : escaped))
    : body.replace(/(\\+)\*/g, (match, slashes: string) => (slashes.length % 2 === 0 ? match : match.slice(1)));
  return { value, wildcard };
}

/** Quote an exact query value, escaping carriage returns so the text survives editors and the clipboard. */
export function quoteQueryValue(value: string): string {
  return `"${value.replace(/["\\*]/g, '\\$&').replaceAll('\r', '\\r')}"`;
}

/** Quotes use standard query escaping around the already encoded pair. */
export function formatRecordTerm(type: string, id: string): string {
  return `record:${quoteQueryValue(encodeRecordPair(type, id))}`;
}
