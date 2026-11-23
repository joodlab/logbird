import { type EntityKind, formatRecordTerm, parseQueryExpression } from '@logbird/contracts';
import { Bot, Building2, Cog, type LucideIcon, Package, User } from 'lucide-react';
import { formatTerm } from './query-language';

/**
 * URL segment ↔ entity kind. The `/workers` URL is kept for compatibility, but the UI calls every executor
 * (API server, queue worker, scheduler, webhook…) an "Executor". `field` is the envelope key that fills the section.
 */
export const ENTITY_SECTIONS = {
  actors: {
    kind: 'actor',
    label: 'Actors',
    singular: 'Actor',
    icon: User,
    field: 'actor',
    blurb: 'Who caused each action: people, API keys, integrations and the scheduler.',
  },
  tenants: {
    kind: 'tenant',
    label: 'Tenants',
    singular: 'Tenant',
    icon: Building2,
    field: 'tenant',
    blurb: 'Which customer or account each action happened in.',
  },
  workers: {
    kind: 'executor',
    label: 'Executors',
    singular: 'Executor',
    icon: Cog,
    field: 'executor',
    blurb: 'What performed each action: your API server, a queue worker or a cron job — with the attempt number.',
  },
  records: {
    kind: 'target',
    label: 'Records',
    singular: 'Record',
    icon: Package,
    field: 'targets',
    blurb: 'What was changed: bookings, rooms, users — any record your events target.',
  },
} as const satisfies Record<string, { kind: EntityKind; label: string; singular: string; icon: LucideIcon; field: string; blurb: string }>;

export type EntitySection = keyof typeof ENTITY_SECTIONS;

export function sectionForKind(kind: EntityKind): EntitySection {
  switch (kind) {
    case 'actor':
      return 'actors';
    case 'tenant':
      return 'tenants';
    case 'executor':
      return 'workers';
    default:
      return 'records';
  }
}

/** Query that selects every event involving the entity. Target ids are "<type>:<id>". */
export function entityQuery(kind: EntityKind, id: string, targetType?: string): string {
  if (kind === 'target' && id.includes(':')) {
    const pair = splitTargetId(id, targetType);
    return formatRecordTerm(pair.type, pair.id);
  }
  return formatTerm(kind, id);
}

/**
 * Whether a profile's all-time count is mentions rather than events. The server reads a record's count from the rollup
 * when its id holds one colon, and the rollup counts each time an event names the record (twice if it lists it twice);
 * with more colons it counts the events themselves (`ambiguousTarget` in packages/clickhouse/src/queries.ts).
 */
export function countsMentions(kind: EntityKind, id: string): boolean {
  return kind === 'target' && id.indexOf(':') === id.lastIndexOf(':');
}

/** The record type to look a record up by: the link's, when it belongs to the id, else the only one a one-colon id has. */
export function lookupType(kind: EntityKind, id: string, linkedType: string | undefined): string | undefined {
  if (kind !== 'target') return undefined;
  if (linkedType !== undefined && id.startsWith(`${linkedType}:`)) return linkedType;
  return countsMentions(kind, id) ? id.slice(0, id.indexOf(':')) : undefined;
}

type SeenBounds = { firstSeen: string; lastSeen: string };

/**
 * The default history window: the union of every source that has answered (the directory's quick first and last seen,
 * the profile's). The first to answer starts the history at once; a later one can only widen it, so the history never
 * leaves out an event the page reports (a late-arriving older event, a directory read cached before it). Null until one
 * answers.
 */
export function historyBounds(...sources: (SeenBounds | null | undefined)[]): SeenBounds | null {
  const known = sources.filter((s): s is SeenBounds => Boolean(s));
  if (!known.length) return null;
  const earliest = known.reduce((a, b) => (Date.parse(b.firstSeen) < Date.parse(a.firstSeen) ? b : a));
  const latest = known.reduce((a, b) => (Date.parse(b.lastSeen) > Date.parse(a.lastSeen) ? b : a));
  return { firstSeen: earliest.firstSeen, lastSeen: latest.lastSeen };
}

/**
 * The filter an entity page's history runs under, or '' while it is not known yet. A record's filter needs its type: a
 * link that carries the exact pair (`?targetType=`, consistent with the id) already has it, so the history starts at
 * once; otherwise it comes with the profile (#220). Other entities never wait.
 */
export function entityBaseQuery(kind: EntityKind, id: string, linkedType: string | undefined, profileType: string | undefined): string {
  if (kind !== 'target') return entityQuery(kind, id);
  const type = linkedType !== undefined && id.startsWith(`${linkedType}:`) ? linkedType : profileType;
  return type === undefined ? '' : entityQuery(kind, id, type);
}

/**
 * How well an entity matches what was typed, best first, the same order the server ranks a search by: 0 the exact id
 * as typed, 1 the id in another case, 2 id prefix, 3 name prefix, 4 id or name contains it, 5 a fuzzy match only. A record's bare id (`article_27_2` for
 * `article:article_27_2`) counts as its id.
 */
export function entityMatchRank(entity: { kind?: EntityKind; id: string; name: string; type?: string }, text: string): EntityMatchRank {
  const typed = text.trim();
  const t = typed.toLowerCase();
  // Only a record loses a prefix, and only its own known type (which may contain colons, or be empty for `:7`):
  // `a:biz_27` is not `biz_27`.
  const record = entity.kind === 'target' && entity.id.startsWith(`${entity.type ?? ''}:`);
  const bareExact = record ? entity.id.slice((entity.type ?? '').length + 1) : entity.id;
  const id = entity.id.toLowerCase();
  const bare = bareExact.toLowerCase();
  const name = entity.name.toLowerCase();
  if (!t) return 5;
  if (entity.id === typed || bareExact === typed) return 0;
  if (id === t || bare === t) return 1;
  if (id.startsWith(t) || bare.startsWith(t)) return 2;
  if (name.startsWith(t)) return 3;
  if (`${id} ${name}`.includes(t)) return 4;
  return 5;
}

/** The id as typed (0) or in another case (1): both are exact ids; the literal one comes first. */
export type EntityMatchRank = 0 | 1 | 2 | 3 | 4 | 5;
export const isExactId = (rank: EntityMatchRank) => rank <= 1;

/**
 * The id that free text could be, or '' when it cannot be one: a single bare word (no field, operator, group or
 * wildcard), or one quoted term (`"acme:27"`, `"acme\"27"`), read as the server's parser reads it: the literal text,
 * escapes resolved.
 */
export function idFromFreeText(text: string): string {
  const t = text.trim();
  if (t.startsWith('"')) return quotedTerm(t);
  return /^[^\s:()"'*-][^\s:()"'*]*$/.test(t) && !/^(AND|OR|NOT)$/.test(t) ? t : '';
}

/**
 * Where Jump to goes for pasted text. An entity whose id is exactly the text wins: a tenant `op_customer` is that
 * tenant, not an operation, whatever its prefix. Otherwise the id's shape decides (`op_…` an operation, `evt_…` or a
 * ULID an event), and anything else is searched.
 */
/** The literal text of `t` when the server reads it as exactly one quoted term, else ''. */
function quotedTerm(t: string): string {
  try {
    const expression = parseQueryExpression(t);
    const atom = expression.length === 1 && expression[0]?.length === 1 ? expression[0][0]?.atom : undefined;
    if (atom?.kind !== 'text' || atom.start !== 0 || atom.end !== t.length || atom.token.kind !== 'value') return '';
    return atom.token.value.trim();
  } catch {
    return '';
  }
}

/**
 * The palette's search value for an entity row. Every row starts with what was typed, so the palette scores them all
 * the same and keeps the server's rank order (exact id, id prefix, name prefix, …) instead of re-sorting by kind.
 */
export const paletteEntityValue = (search: string, e: { kind: EntityKind; id: string }) => `${search.trim()} ${e.kind}:${e.id}`;

export function resolveJump<E extends { kind?: EntityKind; id: string; name: string; type?: string }>(
  text: string,
  shape: 'operation' | 'event' | null,
  entities: readonly E[] | undefined,
): { kind: 'entity'; entity: E } | { kind: 'operation' } | { kind: 'event' } | { kind: 'search' } {
  const exact = (entities ?? [])
    .map((entity, i) => ({ entity, i, rank: entityMatchRank(entity, text) }))
    .filter((x) => isExactId(x.rank))
    .sort((a, b) => a.rank - b.rank || a.i - b.i)[0];
  if (exact) return { kind: 'entity', entity: exact.entity };
  return shape ? { kind: shape } : { kind: 'search' };
}

/** The entities whose id is exactly the text, one per kind (the literal id before a case variant), best first. */
export function exactPerKind<E extends { kind: EntityKind; id: string; name: string; type?: string }>(
  entities: readonly E[] | undefined,
  text: string,
): E[] {
  return (entities ?? [])
    .map((entity, i) => ({ entity, i, rank: entityMatchRank(entity, text) }))
    .filter((x) => isExactId(x.rank))
    .sort((a, b) => a.rank - b.rank || a.i - b.i)
    .filter((x, i, all) => all.findIndex((y) => y.entity.kind === x.entity.kind) === i)
    .map((x) => x.entity);
}

export function targetEntityId(type: string, id: string): string {
  return `${type}:${id}`;
}

export function splitTargetId(entityId: string, type?: string): { type: string; id: string } {
  if (type !== undefined && entityId.startsWith(`${type}:`)) return { type, id: entityId.slice(type.length + 1) };
  const sep = entityId.indexOf(':');
  return sep >= 0 ? { type: entityId.slice(0, sep), id: entityId.slice(sep + 1) } : { type: '', id: entityId };
}

/** Icon for an actor/executor *type*. */
export function typeIcon(kind: EntityKind, type: string): LucideIcon {
  if (kind === 'actor') return type === 'user' || type === 'anonymous' ? User : Bot;
  if (kind === 'executor') return Cog;
  if (kind === 'tenant') return Building2;
  return Package;
}
