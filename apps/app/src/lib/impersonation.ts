import type { AuditEvent, QueryLang } from '@logbird/contracts';
import { parseQueryExpression, type QueryAtom, QueryError, type QueryExpression } from '@logbird/contracts';
import { personLabel } from '@/lib/events';
import { presenceTerms, setPresence } from '@/lib/presence-filter';
import { canonicalField, formatTerm } from '@/lib/query-language';

/**
 * Support impersonation, in plain words. When `impersonator` is set, the actor is the customer it was done *as*
 * and the impersonator is the support agent who was at the keyboard. Every list, page and filter says so.
 */

/** The support agent's display name, falling back to the id. */
export function supportAgentName(e: Pick<AuditEvent, 'impersonator'>): string | null {
  return e.impersonator ? e.impersonator.name || e.impersonator.id : null;
}

/** Query for everything one support agent did while acting as customers. */
export function supportAgentQuery(agentId: string): string {
  return formatTerm('impersonator', agentId);
}

/** "Who did it" split for timelines: everything, only what support did, or only what the party did themselves. */
export type WhoFilter = 'all' | 'support' | 'self';

export const SUPPORT_TERM = 'impersonator:*';

/**
 * Which split a query is in. Any positive support filter (`impersonator:*` or one agent) is "support", `-impersonator:*`
 * is "self"; works in both query languages.
 */
export function whoFilter(q: string, lang: QueryLang = 'query'): WhoFilter {
  if (lang === 'query') return queryWhoFilter(q);
  // SQL conjuncts are top-level ANDs only, so each one restricts the whole query.
  const terms = presenceTerms(q, 'impersonator', lang);
  if (terms.some((t) => !t.negated)) return 'support';
  if (terms.some((t) => t.negated && t.value === null)) return 'self';
  return 'all';
}

/**
 * The split a query-language query is in, read from the server's parse: a restriction counts only when every top-level
 * OR branch has it (`impersonator:amy OR impersonator:bea` is support; `NOT (impersonator:*) OR outcome:failure` is
 * not self). Within a branch only terms that constrain it count: its own terms, groups of one branch, and terms negated
 * through `NOT (a OR b)`; a term in an ORed group or inside `NOT (a b)` restricts nothing on its own. Redundant
 * brackets around the whole query change nothing.
 */
function queryWhoFilter(q: string): WhoFilter {
  let expression: QueryExpression;
  try {
    expression = parseQueryExpression(q);
  } catch (error) {
    if (error instanceof QueryError) return 'all';
    throw error;
  }
  // Redundant brackets around the whole query change nothing: `(a OR b)` is read as `a OR b`.
  for (
    let only = expression[0]?.[0]?.atom;
    expression.length === 1 && expression[0]?.length === 1 && only?.kind === 'group';
    only = expression[0]?.[0]?.atom
  )
    expression = only.expression;
  if (!expression.length) return 'all';
  const branchSplit = (branch: QueryExpression[number]): WhoFilter => {
    let support = false;
    let self = false;
    const visit = (node: QueryAtom, negated: boolean) => {
      if (node.kind === 'not') visit(node.operand, !negated);
      else if (node.kind === 'group') {
        const e = node.expression;
        // One branch: its terms constrain like the branch's own. NOT over single terms ORed: each is negated (De Morgan).
        // A NOT over terms ANDed (`NOT (a b)`) restricts none of them on its own.
        if (e.length === 1 && (!negated || e[0]?.length === 1)) for (const part of e[0] ?? []) visit(part.atom, negated);
        else if (negated && e.every((b) => b.length === 1)) for (const b of e) visit((b[0] as { atom: QueryAtom }).atom, true);
      } else if (node.kind === 'field' && canonicalField(node.field) === 'impersonator') {
        const v = node.value;
        // `_exists_:impersonator` and `impersonator:*` are the same presence test to the server.
        const presence = v.kind === 'presence' || (v.kind === 'value' && v.token.kind !== 'regex' && v.token.wildcard && v.token.value === '*');
        // Only exact agents or presence say who: a regex (`/.*/`) also matches the empty id of self activity, and ranges
        // or comparisons say nothing about support.
        const agents =
          (v.kind === 'value' && v.token.kind !== 'regex' && v.token.value !== '') ||
          (v.kind === 'group' && v.members.every((m) => m.kind !== 'regex' && m.value !== ''));
        if (!negated && (presence || agents)) support = true;
        else if (negated && presence) self = true;
      }
    };
    for (const part of branch) visit(part.atom, false);
    return support ? 'support' : self ? 'self' : 'all';
  };
  const splits = expression.map(branchSplit);
  return splits.every((s) => s === splits[0]) ? (splits[0] as WhoFilter) : 'all';
}

/**
 * Swap the who-split in a query, keeping every other term. Specific agents go with it, so the result never
 * contradicts itself: "self" and "everything" drop every `impersonator:` term; "support" keeps only agent exclusions
 * (`impersonator:* -impersonator:support_2` is still meaningful).
 */
export function withWhoFilter(q: string, who: WhoFilter, lang: QueryLang = 'query'): string {
  if (who === 'support') return setPresence(q, 'impersonator', { value: null, negated: false }, lang, (t) => t.negated && t.value !== null);
  if (who === 'self') return setPresence(q, 'impersonator', { value: null, negated: true }, lang);
  return setPresence(q, 'impersonator', null, lang);
}

/** "done by support agent Leena Ashford while acting as Rohan Mehta": the one phrase rows, labels and tooltips use. */
export function supportPhrase(e: Pick<AuditEvent, 'impersonator' | 'actor'>): string | null {
  const name = supportAgentName(e);
  if (!name) return null;
  return `done by support agent ${name} while acting as ${personLabel(e.actor) || 'an unknown customer'}`;
}

/**
 * Compact background-job hint for a list row: which executor ran it and which try this was. Only for events that
 * came from a job (a job id, or a retry), so interactive actions stay uncluttered.
 */
export function jobHint(e: Pick<AuditEvent, 'executor'>): { executor: string; attempt: number; jobId: string; label: string } | null {
  const x = e.executor;
  if (!x || !(x.jobId || x.attempt > 1)) return null;
  const executor = x.name || x.id || x.type || 'job';
  const attempt = x.attempt;
  const label = [`Background job${x.jobId ? ` ${x.jobId}` : ''}`, x.name || x.id ? `run by ${executor}` : null, attempt > 0 ? `try ${attempt}` : null]
    .filter(Boolean)
    .join(', ');
  return { executor, attempt, jobId: x.jobId, label };
}

/**
 * Where a list row shows its support marker: under the actor's name (desktop), in a dedicated Support agent column
 * if one is showing, else beside the event sentence.
 */
export function supportMarkerPlacement(columns: readonly string[] | undefined): 'actor' | 'column' | 'description' {
  if (columns?.includes('impersonator')) return 'column';
  if (columns?.includes('actor')) return 'actor';
  return 'description';
}

/**
 * Distinct values in a facet, "100+" when the server cut the list. Facets are requested with `field:*`, so events
 * with no actor or tenant never count as one more customer; the filter is a second guard.
 */
export function distinctCount(data: { values: { value: string }[]; otherCount: number } | undefined, format: (n: number) => string = String): string {
  if (!data) return '';
  return `${format(data.values.filter((v) => v.value !== '').length)}${data.otherCount > 0 ? '+' : ''}`;
}

/** The "Who did it" panel's one-line summary, true whether support acted as this entity, this actor is an agent, or both. */
export function splitDescription(kind: string, name: string, counts: { support: number; asAgent: number }): string {
  if (counts.support === 0) return `Support never signed in as ${name} in this range. ${name} is a support agent; that work is kept apart.`;
  return kind === 'actor'
    ? `Some of these events were done by a support agent signed in as ${name}.`
    : 'Some of these events were done by a support agent signed in as a customer.';
}
