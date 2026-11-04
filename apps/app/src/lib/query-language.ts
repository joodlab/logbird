/**
 * Client-side model of the Trailmark query language (docs/SPEC.md §5.1).
 *
 * The server owns parsing → SQL. The console only needs a *lossless* tokenizer to
 * highlight the query bar, drive autocomplete, and add/remove filter terms from facets,
 * charts and entity pages without destroying what the user typed.
 */

export type TokenKind = 'field' | 'text' | 'phrase' | 'operator' | 'paren' | 'space';

export interface QueryToken {
  kind: TokenKind;
  /** Raw source slice, including a leading `-` and quotes. */
  raw: string;
  start: number;
  end: number;
  negated: boolean;
  /** For `field` tokens. */
  field?: string;
  /** Unquoted value for `field` / `phrase` / `text` tokens. */
  value?: string;
}

export interface FieldSpec {
  key: string;
  description: string;
  example: string;
  /** Facet field used to suggest values, when there is one. */
  facet?: string;
}

/** Query fields apps/server understands (SPEC §5.1), in the order autocomplete offers them. */
export const QUERY_FIELDS: FieldSpec[] = [
  { key: 'action', description: 'Exact action, or a prefix with *', example: 'action:hotel.*', facet: 'action' },
  { key: 'outcome', description: 'success · failure · denied · partial · unknown', example: 'outcome:failure', facet: 'outcome' },
  { key: 'severity', description: 'info · notice · warning · critical', example: 'severity:critical', facet: 'severity' },
  { key: 'actor', description: 'Actor id', example: 'actor:usr_42', facet: 'actor' },
  { key: 'actor.type', description: 'user · service · system · api_key · integration', example: 'actor.type:user', facet: 'actor.type' },
  { key: 'actor.name', description: 'Actor display name', example: 'actor.name:"Raed B"' },
  { key: 'tenant', description: 'Tenant id', example: 'tenant:biz_7', facet: 'tenant' },
  { key: 'executor', description: 'Worker / job / api that performed it', example: 'executor:crm-worker', facet: 'executor' },
  { key: 'executor.type', description: 'api · worker · scheduler · webhook', example: 'executor.type:worker', facet: 'executor.type' },
  { key: 'target', description: 'Target record id', example: 'target:hotel_123' },
  { key: 'target.type', description: 'Target record type', example: 'target.type:hotel', facet: 'target.type' },
  { key: 'category', description: 'First segment of the action', example: 'category:booking', facet: 'category' },
  { key: 'env', description: 'Environment', example: '-env:staging', facet: 'environment' },
  { key: 'source', description: 'External system that supplied the change', example: 'source:staybook', facet: 'source' },
  { key: 'operation', description: 'Operation id (request + spawned jobs)', example: 'operation:op_101' },
  { key: 'request', description: 'Request id', example: 'request:req_abc' },
  { key: 'trace', description: 'Trace id', example: 'trace:4bf92f…' },
  { key: 'id', description: 'Event id', example: 'id:01J…' },
  { key: 'attr.', description: 'Any attribute, e.g. attr.metadata.plan', example: 'attr.metadata.plan:pro' },
];

const FIELD_RE = /^(-?)([A-Za-z_][\w.]*):("(?:[^"\\]|\\.)*"?|[^\s()]*)/;
const PHRASE_RE = /^(-?)"((?:[^"\\]|\\.)*)"?/;
const WORD_RE = /^(-?)([^\s()"]+)/;

function unquote(value: string): string {
  if (value.startsWith('"')) {
    const inner = value.endsWith('"') && value.length > 1 ? value.slice(1, -1) : value.slice(1);
    return inner.replaceAll('\\"', '"');
  }
  return value;
}

/** Tokenize a query. Concatenating every token's `raw` reproduces the input exactly. */
export function tokenize(input: string): QueryToken[] {
  const tokens: QueryToken[] = [];
  let i = 0;
  while (i < input.length) {
    const rest = input.slice(i);
    const space = /^\s+/.exec(rest);
    if (space) {
      tokens.push({ kind: 'space', raw: space[0], start: i, end: i + space[0].length, negated: false });
      i += space[0].length;
      continue;
    }
    const ch = rest[0] ?? '';
    if (ch === '(' || ch === ')') {
      tokens.push({ kind: 'paren', raw: ch, start: i, end: i + 1, negated: false });
      i += 1;
      continue;
    }
    const field = FIELD_RE.exec(rest);
    if (field) {
      const raw = field[0];
      tokens.push({
        kind: 'field',
        raw,
        start: i,
        end: i + raw.length,
        negated: field[1] === '-',
        // Case is significant: unknown fields are attribute keys (attr.metadata.supportTicket).
        field: field[2] ?? '',
        value: unquote(field[3] ?? ''),
      });
      i += raw.length;
      continue;
    }
    const phrase = PHRASE_RE.exec(rest);
    if (phrase) {
      const raw = phrase[0];
      tokens.push({ kind: 'phrase', raw, start: i, end: i + raw.length, negated: phrase[1] === '-', value: phrase[2] ?? '' });
      i += raw.length;
      continue;
    }
    const word = WORD_RE.exec(rest);
    if (word) {
      const raw = word[0];
      const isOperator = raw === 'OR' || raw === 'AND' || raw === 'NOT';
      tokens.push({
        kind: isOperator ? 'operator' : 'text',
        raw,
        start: i,
        end: i + raw.length,
        negated: !isOperator && word[1] === '-',
        value: word[2] ?? raw,
      });
      i += raw.length;
      continue;
    }
    // Unreachable in practice; keep the tokenizer total.
    tokens.push({ kind: 'text', raw: ch, start: i, end: i + 1, negated: false, value: ch });
    i += 1;
  }
  return tokens;
}

/** Normalize aliases so `env` and `environment` compare equal. */
export function canonicalField(field: string): string {
  if (field === 'environment') return 'env';
  return field;
}

function quoteIfNeeded(value: string): string {
  return /[\s()"]/.test(value) || value === '' ? `"${value.replaceAll('"', '\\"')}"` : value;
}

export function formatTerm(field: string, value: string, negated = false): string {
  return `${negated ? '-' : ''}${field}:${quoteIfNeeded(value)}`;
}

function join(tokens: QueryToken[]): string {
  return tokens
    .map((t) => t.raw)
    .join('')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** Field terms present in the query (non-space tokens only). */
export function fieldTerms(q: string): QueryToken[] {
  return tokenize(q).filter((t) => t.kind === 'field');
}

export function hasTerm(q: string, field: string, value: string, negated?: boolean): boolean {
  const f = canonicalField(field);
  return fieldTerms(q).some((t) => canonicalField(t.field ?? '') === f && t.value === value && (negated === undefined || t.negated === negated));
}

/** Remove every term for `field` (optionally only one value / polarity). */
export function removeTerm(q: string, field: string, value?: string, negated?: boolean): string {
  const f = canonicalField(field);
  const kept = tokenize(q).filter(
    (t) =>
      !(
        t.kind === 'field' &&
        canonicalField(t.field ?? '') === f &&
        (value === undefined || t.value === value) &&
        (negated === undefined || t.negated === negated)
      ),
  );
  return join(kept);
}

/**
 * Include `field:value`. The v0 grammar ANDs terms, so including a second value for the same
 * field would match nothing: positive terms for that field are replaced instead.
 */
export function includeTerm(q: string, field: string, value: string): string {
  const without = removeTerm(removeTerm(q, field, undefined, false), field, value, true);
  return `${without} ${formatTerm(field, value)}`.trim();
}

/** Exclude `field:value` (any number of exclusions can coexist). */
export function excludeTerm(q: string, field: string, value: string): string {
  const without = removeTerm(q, field, value);
  return `${without} ${formatTerm(field, value, true)}`.trim();
}

/** Toggle helper used by facet rows: click → include / un-include; alt-click → exclude / un-exclude. */
export function toggleTerm(q: string, field: string, value: string, mode: 'include' | 'exclude'): string {
  if (mode === 'include') {
    return hasTerm(q, field, value, false) ? removeTerm(q, field, value, false) : includeTerm(q, field, value);
  }
  return hasTerm(q, field, value, true) ? removeTerm(q, field, value, true) : excludeTerm(q, field, value);
}

/** The token under the caret, for autocomplete. */
export function tokenAt(q: string, caret: number): QueryToken | undefined {
  return tokenize(q).find((t) => t.kind !== 'space' && caret >= t.start && caret <= t.end);
}

/** Map query fields to the facet API field names. */
export function facetFieldFor(field: string): string | undefined {
  const f = canonicalField(field);
  if (f.startsWith('attr.')) return f;
  return QUERY_FIELDS.find((spec) => spec.key === f)?.facet;
}

/** Map facet API field names back to query fields. */
export function queryFieldForFacet(facet: string): string {
  if (facet === 'environment') return 'env';
  return facet;
}
