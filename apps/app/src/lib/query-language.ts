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
  /** Suggest the facet's labels (names) instead of its values (ids). */
  byLabel?: boolean;
  /** Entity directory used to suggest ids (by name or id) for high-cardinality fields. */
  entity?: 'actor' | 'tenant' | 'executor' | 'target';
}

/** Query fields apps/server understands (SPEC §5.1), in the order autocomplete offers them. */
export const QUERY_FIELDS: FieldSpec[] = [
  { key: 'action', description: 'Exact action, or a prefix with *', example: 'action:hotel.*', facet: 'action' },
  { key: 'outcome', description: 'success · failure · denied · partial · unknown', example: 'outcome:failure', facet: 'outcome' },
  { key: 'severity', description: 'info · notice · warning · critical', example: 'severity:critical', facet: 'severity' },
  { key: 'actor', description: 'Who caused it (actor id)', example: 'actor:usr_42', entity: 'actor' },
  { key: 'actor.name', description: 'Actor display name', example: 'actor.name:"Raed B"', facet: 'actor', byLabel: true },
  { key: 'actor.email', description: 'Actor email', example: 'actor.email:raed@example.com' },
  { key: 'actor.type', description: 'user · service · system · api_key · integration', example: 'actor.type:user', facet: 'actor.type' },
  { key: 'impersonator', description: 'Support user acting as the actor', example: 'impersonator:usr_1' },
  { key: 'tenant', description: 'Customer account (tenant id)', example: 'tenant:biz_7', entity: 'tenant' },
  { key: 'tenant.name', description: 'Tenant display name', example: 'tenant.name:"Azure Hotels"', facet: 'tenant', byLabel: true },
  { key: 'executor', description: 'Worker, job or API that performed it', example: 'executor:crm-worker', entity: 'executor' },
  { key: 'executor.name', description: 'Executor display name', example: 'executor.name:"CRM worker"', facet: 'executor', byLabel: true },
  { key: 'executor.type', description: 'api · worker · scheduler · webhook', example: 'executor.type:worker', facet: 'executor.type' },
  { key: 'job', description: 'Job id the executor ran', example: 'job:456' },
  { key: 'target', description: 'Record the event touched (target id)', example: 'target:hotel_123', entity: 'target' },
  { key: 'target.type', description: 'Record type', example: 'target.type:hotel', facet: 'target.type' },
  { key: 'category', description: 'First segment of the action', example: 'category:booking', facet: 'category' },
  { key: 'env', description: 'Environment', example: '-env:staging', facet: 'environment' },
  { key: 'source', description: 'External system that supplied the change', example: 'source:joodbooking', facet: 'source' },
  { key: 'operation', description: 'Operation id (request + spawned jobs)', example: 'operation:op_101' },
  { key: 'parent', description: 'Parent event id (direct children)', example: 'parent:evt_123' },
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
      // `OR` is the only keyword; adjacency means AND (SPEC §5.1).
      const isOperator = raw === 'OR';
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

/**
 * Drop operators and groups that removing a term left dangling — `(a OR b)` minus `a` and `b` must
 * not become `( OR )`, which the server rightly rejects.
 */
function tidy(tokens: QueryToken[]): QueryToken[] {
  let current = tokens;
  for (;;) {
    const solid = current.filter((t) => t.kind !== 'space');
    const drop = new Set<QueryToken>();
    solid.forEach((t, i) => {
      const prev = solid[i - 1];
      const next = solid[i + 1];
      if (t.kind === 'operator' && (!prev || !next || prev.raw === '(' || next.raw === ')' || next.kind === 'operator')) drop.add(t);
      if (t.raw === '(' && next?.raw === ')') {
        drop.add(t);
        drop.add(next);
      }
    });
    current.forEach((t, i) => {
      if (t.kind === 'space' && (current[i - 1]?.raw === '(' || current[i + 1]?.raw === ')')) drop.add(t);
    });
    if (drop.size === 0) return current;
    current = current.filter((t) => !drop.has(t));
  }
}

function join(tokens: QueryToken[]): string {
  return tidy(tokens)
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
 * Include `field:value`. Adjacent terms are ANDed, so including a second value for the same
 * field would match nothing: positive terms for that field are replaced instead (people who want
 * either value write `(a OR b)` themselves).
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

/** Autocomplete spec for a query field; `attr.*` keys suggest values from their own facet. */
export function fieldSpec(field: string): FieldSpec | undefined {
  const f = canonicalField(field);
  if (f.startsWith('attr.')) return { key: f, description: 'Attribute', example: `${f}:…`, facet: f };
  return QUERY_FIELDS.find((spec) => spec.key === f);
}

/** Map facet API field names back to query fields. */
export function queryFieldForFacet(facet: string): string {
  if (facet === 'environment') return 'env';
  return facet;
}
