import { type EntityKind, formatRecordTerm } from '@logbird/contracts';
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
 * wildcard), or one quoted term (`"acme:27"`, which the query language reads as the literal text).
 */
export function idFromFreeText(text: string): string {
  const t = text.trim();
  const quoted = /^"([^"\\]+)"$/.exec(t);
  if (quoted) return quoted[1]?.trim() ?? '';
  return /^[^\s:()"'*-][^\s:()"'*]*$/.test(t) && !/^(AND|OR|NOT)$/.test(t) ? t : '';
}

/**
 * Where Jump to goes for pasted text. An entity whose id is exactly the text wins: a tenant `op_customer` is that
 * tenant, not an operation, whatever its prefix. Otherwise the id's shape decides (`op_…` an operation, `evt_…` or a
 * ULID an event), and anything else is searched.
 */
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
