/**
 * Familiar syntax from other search bars (Lucene / Kibana KQL / Datadog / GitHub) that the Logbird query
 * language spells differently. Pure: finds the spans and proposes the Logbird form. The query bar shows each
 * fix as the first suggestion with a hint, and applies the unambiguous ones when the query is run.
 *
 * Nothing here changes what the server accepts (the server parser is the source of truth).
 */
import { parseQueryExpression, type QueryAtom, QueryError } from '@logbird/contracts';
import { coreField } from './query-catalog';
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
  // Never from inside a value the server reads as one: text in `@meta:"please !tenant:t here"` is data, not syntax to
  // fix, even when the proposed span runs on past the value's end (`"meta":"please !tenant:t"tail`).
  const values = serverValueSpans(q);
  const fixes = lintTokens(q, isField).filter((f) => !values.some((v) => f.start >= v.start && f.start < v.end));
  const terms = serverTermSpans(q);
  if (!terms) return fixes;
  // A query the server accepts: a fix respells whole server terms, one term or the words of a comparison (`tenant =`),
  // never a span the console's tokenizer read differently (`action: (ab"cd OR next) tenant:west` is two field terms),
  // and only when the result still parses (`action=OR` has no filter form).
  return fixes.filter((f) => {
    const starts = (t: { start: number }) => f.start === t.start || (f.start === t.start - 1 && /[-!]/.test(q[f.start] ?? ''));
    const covered = terms.filter((t) => t.start < f.end && t.end > f.start);
    const whole =
      covered.length > 0 &&
      covered.every((t) => t.start >= f.start - 1 && t.end <= f.end) &&
      covered.some(starts) &&
      covered.some((t) => t.end === f.end) &&
      (covered.length === 1 || covered.every((t) => t.kind === 'text'));
    const fixed = q.slice(0, f.start) + f.replacement + q.slice(f.end);
    return whole && (serverAccepts(fixed) || (f.incomplete === true && serverAccepts(`${fixed}x`)));
  });
}

/** The spans of the server's terms (fields and words, at any depth); null when `q` does not parse. */
function serverTermSpans(q: string): { start: number; end: number; kind: string }[] | null {
  const spans: { start: number; end: number; kind: string }[] = [];
  const visit = (node: QueryAtom) => {
    if (node.kind === 'not') visit(node.operand);
    else if (node.kind === 'group') for (const branch of node.expression) for (const part of branch) visit(part.atom);
    else spans.push({ start: node.start, end: node.end, kind: node.kind });
  };
  try {
    for (const branch of parseQueryExpression(q)) for (const part of branch) visit(part.atom);
  } catch (error) {
    if (error instanceof QueryError) return null;
    throw error;
  }
  return spans;
}

/** Where the server's parse has field values (none when it does not parse: then every fix is a candidate). */
function serverValueSpans(q: string): { start: number; end: number }[] {
  const spans: { start: number; end: number }[] = [];
  const visit = (node: QueryAtom) => {
    if (node.kind === 'not') visit(node.operand);
    else if (node.kind === 'group') for (const branch of node.expression) for (const part of branch) visit(part.atom);
    else if (node.kind === 'field') spans.push({ start: node.valueStart, end: node.end });
  };
  try {
    for (const branch of parseQueryExpression(q)) for (const part of branch) visit(part.atom);
  } catch (error) {
    if (!(error instanceof QueryError)) throw error;
  }
  return spans;
}

function lintTokens(q: string, isField: (name: string) => boolean): QueryFix[] {
  const fixes: QueryFix[] = [];
  const solid = tokenize(q).filter((t) => t.kind !== 'space');
  const valueRaw = (t?: QueryToken) => (t && (t.kind === 'text' || t.kind === 'phrase') && !t.negated ? t.raw : null);

  for (let i = 0; i < solid.length; i += 1) {
    const t = solid[i] as QueryToken;
    const next = solid[i + 1];

    // Lucene `_exists_:field` / `NOT _exists_:field` → `field:*` / `-field:*`.
    // (Not for a field literally named `_exists_`: `_exists_:*` would ask about another field.)
    if (
      t.kind === 'field' &&
      t.field === '_exists_' &&
      t.valueKind === 'plain' &&
      t.value &&
      t.value !== '_exists_' &&
      /^[A-Za-z_][\w.$@-]*$/.test(t.value)
    ) {
      fixes.push({
        start: t.start,
        end: t.end,
        replacement: `${t.negated ? '-' : ''}${t.value}:*`,
        message: 'Lucene _exists_ (and -field:* means missing)',
      });
      continue;
    }

    // Canonicalize optional spacing without changing the value or how it is lexed.
    if (t.kind === 'field' && t.value && t.valueStart !== undefined) {
      // The key as written (a quoted key keeps its quotes), never rebuilt from the decoded name.
      const keyEnd = t.keyEnd ?? t.start + (t.negated ? 1 : 0) + (t.field?.length ?? 0);
      const prefix = `${t.raw.slice(0, keyEnd - t.start)}:`;
      const value = t.raw.slice(t.valueStart - t.start);
      if (t.raw !== prefix + value && !/^[-!]|^[\w.]+:/.test(value)) {
        fixes.push({ start: t.start, end: t.end, replacement: prefix + value, message: 'Remove space around the colon' });
      }
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

/** Whether the server accepts `q` exactly as written. */
export function serverAccepts(q: string): boolean {
  try {
    parseQueryExpression(q);
    return true;
  } catch (error) {
    if (error instanceof QueryError) return false;
    throw error;
  }
}

/**
 * The fixes Enter applies: only to a query the server rejects (`tenant = biz_7`, `!env:staging`, `a && b`), as before.
 * A query the server accepts runs exactly as typed, whatever it looks like (`action=booked` searches that text).
 */
export function fixesOnSubmit(q: string, fixes: QueryFix[]): QueryFix[] {
  return serverAccepts(q) ? [] : autoFixes(fixes);
}

/**
 * The filter to offer for a query the server accepts as text but that is spelled like a KQL comparison on a known field
 * (`action=booked` searches the words; `action:booked` is the filter): the reader chooses, nothing is applied. Null when
 * there is nothing to offer.
 */
export function suggestedConversion(q: string, fixes: QueryFix[]): string | null {
  if (!q.trim() || !serverAccepts(q)) return null;
  const comparisons = autoFixes(fixes).filter((f) => f.message.startsWith('KQL-style'));
  if (!comparisons.length) return null;
  // Offered only when the filter is itself a query the parser accepts (`action=OR` has no plain filter form).
  const converted = applyFixes(q, comparisons).trim();
  return serverAccepts(converted) ? converted : null;
}

/** Fields a KQL comparison may name without the attribute list at hand: core fields and explicit attributes. */
export const isKnownFieldName = (name: string) => Boolean(coreField(name)) || /^(attr|attributes)\.\S/.test(name);
