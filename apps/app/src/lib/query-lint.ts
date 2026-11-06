/**
 * Familiar syntax from other search bars (Lucene / Kibana KQL / Datadog / GitHub) that the Logbird query
 * language spells differently. Pure: finds the spans and proposes the Logbird form. The query bar shows each
 * fix as the first suggestion with a hint, and applies the unambiguous ones when the query is run.
 *
 * Nothing here changes what the server accepts (the server parser is the source of truth).
 */
import { type QueryToken, tokenize } from './query-language';

export interface QueryFix {
  /** Half-open source span to replace. */
  start: number;
  end: number;
  replacement: string;
  /** Short explanation for the hint row, e.g. "KQL `=` → `field:value`". */
  message: string;
  /**
   * Only a hint, never applied automatically: the original could be intended (lower-case `and` may be a word the
   * user is searching for).
   */
  soft?: boolean;
  /** The replacement still needs a value (`tenant =` → `tenant:`): keep completing after accepting it. */
  incomplete?: boolean;
}

const COMPARE = /^(==|!=|=|>=|<=|>|<)$/;
const COMPARE_PREFIX = /^(==|!=|=|>=|<=|>|<)(.+)$/;
const GLUED = /^([A-Za-z_][\w.@$-]*?)(==|!=|=|>=|<=|>|<)(.*)$/;
const LOWER_OPERATORS: Record<string, string> = { and: 'AND', or: 'OR', not: 'NOT', '&&': 'AND', '||': 'OR' };

/** `field = value` → `field:value` etc. `value` may be empty (still typing). */
function rewrite(field: string, op: string, value: string, negated: boolean): { text: string; incomplete: boolean } {
  const neg = negated !== (op === '!=') ? '-' : '';
  const cmp = op === '=' || op === '==' || op === '!=' ? '' : op;
  return { text: `${neg}${field}:${cmp}${value}`, incomplete: value === '' };
}

/**
 * Fixes for `q`. `isField` says whether a bare word names a field (core key, alias or a known attribute key) —
 * only then is `word = value` read as a comparison rather than free text.
 */
export function lintQuery(q: string, isField: (name: string) => boolean): QueryFix[] {
  const fixes: QueryFix[] = [];
  const solid = tokenize(q).filter((t) => t.kind !== 'space');
  const raw = (t?: QueryToken) => t?.raw ?? '';
  const valueRaw = (t?: QueryToken) => (t && (t.kind === 'text' || t.kind === 'phrase') && !t.negated ? t.raw : null);

  for (let i = 0; i < solid.length; i += 1) {
    const t = solid[i] as QueryToken;
    const next = solid[i + 1];

    // Lucene `_exists_:field` / `NOT _exists_:field` → `field:*` / `-field:*`.
    if (t.kind === 'field' && t.field === '_exists_' && t.valueKind === 'plain' && t.value) {
      fixes.push({
        start: t.start,
        end: t.end,
        replacement: `${t.negated ? '-' : ''}${t.value}:*`,
        message: 'Lucene _exists_ (and -field:* means missing)',
      });
      continue;
    }

    // `field: value` / `field : value` (Kibana spacing): the server reads it as field:value; write it that way.
    if (t.kind === 'field' && t.valueKind === 'plain' && t.value === '' && next && next.start > t.end && valueRaw(next) !== null) {
      const v = raw(next);
      fixes.push({ start: t.start, end: next.end, replacement: `${raw(t)}${v}`, message: 'No space after the colon' });
      i += 1;
      continue;
    }
    if (t.kind === 'text' && !t.negated && isField(t.raw) && next?.kind === 'text' && next.raw.startsWith(':') && next.start > t.end) {
      fixes.push({ start: t.start, end: next.end, replacement: `${t.raw}${next.raw}`, message: 'No space before the colon' });
      i += 1;
      continue;
    }

    // `!field:x` → `-field:x`.
    if (t.kind === 'text' && /^![A-Za-z_][\w.$@-]*:/.test(t.raw)) {
      fixes.push({ start: t.start, end: t.end, replacement: `-${t.raw.slice(1)}`, message: 'Exclude with a leading - (or NOT)' });
      continue;
    }

    // KQL / SQL-ish comparisons: `field = v`, `field != v`, `field >= 10`, glued `field=v`, `field =v`.
    if (t.kind === 'text') {
      const word = t.negated ? t.raw.slice(1) : t.raw;
      const glued = GLUED.exec(word);
      if (glued && isField(glued[1] ?? '')) {
        const [, field = '', op = '', v = ''] = glued;
        const r = rewrite(field, op, v, t.negated);
        fixes.push({
          start: t.start,
          end: t.end,
          replacement: r.text,
          message: `KQL-style ${op}`,
          incomplete: r.incomplete,
        });
        continue;
      }
      if (isField(word) && next?.kind === 'text') {
        const opMatch = COMPARE.exec(next.raw);
        const opGlued = COMPARE_PREFIX.exec(next.raw);
        if (opMatch) {
          const op = opMatch[1] ?? '=';
          const value = solid[i + 2];
          const v = value && valueRaw(value) !== null && !COMPARE.test(value.raw) ? value.raw : '';
          const r = rewrite(word, op, v, t.negated);
          fixes.push({
            start: t.start,
            end: v ? (value?.end ?? next.end) : next.end,
            replacement: r.text,
            message: `KQL-style ${op}`,
            incomplete: r.incomplete,
          });
          i += v ? 2 : 1;
          continue;
        }
        if (opGlued) {
          const r = rewrite(word, opGlued[1] ?? '=', opGlued[2] ?? '', t.negated);
          fixes.push({ start: t.start, end: next.end, replacement: r.text, message: `KQL-style ${opGlued[1]}` });
          i += 1;
          continue;
        }
      }
    }

    // `&&` / `||` / lower-case and, or, not between terms.
    if (t.kind === 'text' && !t.negated && t.raw in LOWER_OPERATORS) {
      const up = LOWER_OPERATORS[t.raw] as string;
      const prev = solid[i - 1];
      const between = Boolean(prev && next && prev.kind !== 'operator' && next.kind !== 'operator' && next.raw !== ')');
      const symbol = t.raw === '&&' || t.raw === '||';
      // `not x` at the start is also an operator; `and` / `or` need terms on both sides.
      if (symbol || between || (t.raw === 'not' && next && next.kind !== 'operator')) {
        fixes.push({
          start: t.start,
          end: t.end,
          replacement: up,
          message: symbol ? `${t.raw} is ${up}` : `Operators are upper-case; lower-case "${t.raw}" is searched as text`,
          soft: !symbol,
        });
      }
    }
  }
  return fixes;
}

/** Apply non-overlapping fixes (later spans first so offsets stay valid). */
export function applyFixes(q: string, fixes: QueryFix[]): string {
  return [...fixes].sort((a, b) => b.start - a.start).reduce((text, f) => text.slice(0, f.start) + f.replacement + text.slice(f.end), q);
}

/** Fixes worth applying silently when the query runs (everything that is not just a hint). */
export function autoFixes(fixes: QueryFix[]): QueryFix[] {
  return fixes.filter((f) => !(f.soft || f.incomplete));
}
